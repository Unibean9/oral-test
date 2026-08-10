import { v4 as uuidv4 } from 'uuid';
import { db } from './connection.js';

export const ORAL_SESSION_ID_PREFIX = 'os_';
export const RETENTION_DAYS = 180;

export type OralSessionStatus = 'in_progress' | 'completed' | 'reviewed' | 'approved';
export type OralSessionCompletionReason = 'coverage_verified' | 'ended_early';

export interface AssessmentSessionRow {
  session_id: string;
  blueprint_id: string;
  teacher_id: string;
  student_code: string;
  status: OralSessionStatus;
  started_at: string;
  ended_at: string | null;
  expires_at: string;
  claude_session_id: string | null;
  completion_reason: OralSessionCompletionReason | null;
  coverage_snapshot_hash: string | null;
  lease_generation: number;
  examiner_skill_digest: string | null;
  examiner_cli_version: string | null;
}

function isOralSessionId(value: string): boolean {
  return typeof value === 'string' && value.startsWith(ORAL_SESSION_ID_PREFIX);
}

const insertSession = db.prepare(
  `INSERT INTO assessment_sessions (session_id, blueprint_id, teacher_id, student_code, status, started_at, expires_at)
   VALUES (?, ?, ?, ?, 'in_progress', ?, ?)`,
);
export function createOralSession(params: { blueprintId: string; teacherId: string; studentCode: string }): AssessmentSessionRow {
  const sessionId = `${ORAL_SESSION_ID_PREFIX}${uuidv4()}`;
  const now = new Date();
  const startedAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  insertSession.run(sessionId, params.blueprintId, params.teacherId, params.studentCode, startedAt, expiresAt);
  return {
    session_id: sessionId, blueprint_id: params.blueprintId, teacher_id: params.teacherId,
    student_code: params.studentCode, status: 'in_progress', started_at: startedAt, ended_at: null, expires_at: expiresAt,
    claude_session_id: null, completion_reason: null, coverage_snapshot_hash: null, lease_generation: 0,
    examiner_skill_digest: null, examiner_cli_version: null,
  };
}

const selectById = db.prepare('SELECT * FROM assessment_sessions WHERE session_id = ?');
export function getOralSession(sessionId: string): AssessmentSessionRow | undefined {
  return selectById.get(sessionId) as AssessmentSessionRow | undefined;
}

const selectByTeacher = db.prepare('SELECT * FROM assessment_sessions WHERE teacher_id = ? ORDER BY started_at DESC');
export function listOralSessionsForTeacher(teacherId: string): AssessmentSessionRow[] {
  return selectByTeacher.all(teacherId) as AssessmentSessionRow[];
}

const setStatusStmt = db.prepare('UPDATE assessment_sessions SET status = ? WHERE session_id = ?');
export function setOralSessionStatus(sessionId: string, status: OralSessionStatus): void {
  setStatusStmt.run(status, sessionId);
}

const endSessionStmt = db.prepare(
  `UPDATE assessment_sessions
   SET status = 'completed', ended_at = ?, completion_reason = ?, coverage_snapshot_hash = ?
   WHERE session_id = ? AND status = 'in_progress'`,
);
const endSessionFencedStmt = db.prepare(
  `UPDATE assessment_sessions
   SET status = 'completed', ended_at = ?, completion_reason = ?, coverage_snapshot_hash = ?
   WHERE session_id = ? AND status = 'in_progress' AND lease_generation = ?`,
);
/**
 * Compare-and-set: only an `in_progress` session can transition to `completed` here.
 * `reason` defaults to `ended_early` — the manual `/end` route and any early-exit call site never
 * has grounds to claim `coverage_verified`; only questionEngine's normal all-slots-satisfied path
 * passes that reason explicitly, alongside the coverage snapshot hash it computed.
 *
 * `expectedLeaseGeneration`, when passed, additionally requires the session to still be
 * `in_progress` under the exact generation the caller claimed via `claimSessionLease` before this
 * call — see that function's doc comment for what this fences against. The unfenced overload
 * (no `expectedLeaseGeneration`) is still a plain CAS on `status = 'in_progress'`, which is what
 * makes it safe for a call site like the manual `/end` route that never claims a lease at all.
 */
export function endOralSession(
  sessionId: string,
  options: { reason?: OralSessionCompletionReason; coverageSnapshotHash?: string; expectedLeaseGeneration?: number } = {},
): boolean {
  const reason = options.reason ?? 'ended_early';
  const hash = options.coverageSnapshotHash ?? null;
  const now = new Date().toISOString();
  const result = options.expectedLeaseGeneration === undefined
    ? endSessionStmt.run(now, reason, hash, sessionId)
    : endSessionFencedStmt.run(now, reason, hash, sessionId, options.expectedLeaseGeneration);
  return result.changes > 0;
}

export class SessionLeaseFencedError extends Error {
  constructor(sessionId: string) {
    super(`session ${sessionId}'s lease generation was superseded before this operation could commit`);
    this.name = 'SessionLeaseFencedError';
  }
}

const claimLeaseStmt = db.prepare(
  `UPDATE assessment_sessions SET lease_generation = lease_generation + 1 WHERE session_id = ? AND status = 'in_progress'`,
);
const selectLeaseStateStmt = db.prepare("SELECT status, lease_generation FROM assessment_sessions WHERE session_id = ?");

/**
 * Claims a fresh `lease_generation` for the caller about to invoke the examiner CLI and persist
 * its result. `assertLeaseCurrent`, called after the (awaited) CLI call returns and before any
 * write, must be passed this same generation back — a request whose generation was superseded by
 * a later claim, or whose session left `in_progress` in the meantime, is fenced out instead of
 * committing.
 *
 * `better-sqlite3` calls are synchronous, so nothing can race the claim itself; a single Node
 * process also holds this repo's only writable handle to the DB (see `singleWriterLock.ts`) — the
 * actual gap this closes is not cross-process, but the async gap within one process: the `/end`
 * route (and any future call site that mutates a session's status without holding
 * `withRoomLock`) can otherwise complete while a same-session `askNextQuestionLocked` call is
 * mid-`await` on the CLI, and that call's result must not then be written as if the session were
 * still open. `withRoomLock` already serializes two concurrent callers that both take the lock;
 * this covers the case where one of them doesn't.
 *
 * Returns `null` if the session is not `in_progress` (nothing to claim) — callers must treat that
 * the same as an immediately-fenced attempt and must not proceed to invoke the CLI.
 */
export function claimSessionLease(sessionId: string): number | null {
  const result = claimLeaseStmt.run(sessionId);
  if (result.changes === 0) return null;
  const row = selectLeaseStateStmt.get(sessionId) as { status: string; lease_generation: number } | undefined;
  return row ? row.lease_generation : null;
}

/**
 * Throws `SessionLeaseFencedError` unless `sessionId` is still `in_progress` AND its current
 * lease generation still matches `expectedGeneration`. Called immediately after the CLI call
 * returns and before any write follows from it (see `claimSessionLease`).
 */
export function assertLeaseCurrent(sessionId: string, expectedGeneration: number): void {
  const row = selectLeaseStateStmt.get(sessionId) as { status: string; lease_generation: number } | undefined;
  if (!row || row.status !== 'in_progress' || row.lease_generation !== expectedGeneration) throw new SessionLeaseFencedError(sessionId);
}

const bindClaudeSessionStmt = db.prepare(
  `UPDATE assessment_sessions SET claude_session_id = ?, examiner_skill_digest = ?, examiner_cli_version = ? WHERE session_id = ? AND claude_session_id IS NULL`,
);
/**
 * Binds the session's persisted CLI session id, the oral-examiner skill digest, and the `claude`
 * CLI version current at first-call time, exactly once. The `claude_session_id IS NULL` guard
 * makes a second call a no-op instead of overwriting values another concurrent call already
 * bound — the resumed id, once set, is the one every later turn must `--resume`, and the digest/
 * version are what every later resume checks the currently-deployed skill/CLI against (see
 * examinerSkillDigest()/examinerCliVersion()).
 */
export function bindClaudeSession(sessionId: string, claudeSessionId: string, examinerSkillDigest: string, examinerCliVersion: string): void {
  bindClaudeSessionStmt.run(claudeSessionId, examinerSkillDigest, examinerCliVersion, sessionId);
}

// Ownership check used by ownershipGuard: resolves a session's owning teacher_id, or undefined if
// the session does not exist / the id shape is not this domain's.
export function resolveOralSessionOwner(sessionId: string): string | undefined {
  if (!isOralSessionId(sessionId)) return undefined;
  return getOralSession(sessionId)?.teacher_id;
}

const selectExpired = db.prepare("SELECT session_id FROM assessment_sessions WHERE expires_at < ?");
/** Retention: session ids whose 180-day window has elapsed. Deletion itself is the caller's job
 * (a scheduled job or manual admin action) — this module only identifies candidates. */
export function listExpiredOralSessionIds(nowIso = new Date().toISOString()): string[] {
  return (selectExpired.all(nowIso) as Array<{ session_id: string }>).map((r) => r.session_id);
}
