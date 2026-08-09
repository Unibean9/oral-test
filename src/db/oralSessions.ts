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
    claude_session_id: null, completion_reason: null, coverage_snapshot_hash: null,
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
/**
 * Compare-and-set: only an `in_progress` session can transition to `completed` here.
 * `reason` defaults to `ended_early` — the manual `/end` route and any early-exit call site never
 * has grounds to claim `coverage_verified`; only questionEngine's normal all-slots-satisfied path
 * passes that reason explicitly, alongside the coverage snapshot hash it computed.
 */
export function endOralSession(
  sessionId: string,
  options: { reason?: OralSessionCompletionReason; coverageSnapshotHash?: string } = {},
): boolean {
  const result = endSessionStmt.run(
    new Date().toISOString(), options.reason ?? 'ended_early', options.coverageSnapshotHash ?? null, sessionId,
  );
  return result.changes > 0;
}

const setClaudeSessionIdStmt = db.prepare(
  `UPDATE assessment_sessions SET claude_session_id = ? WHERE session_id = ? AND claude_session_id IS NULL`,
);
/**
 * Sets the session's persisted CLI session id exactly once. The `claude_session_id IS NULL` guard
 * makes a second call a no-op instead of overwriting an id another concurrent call already bound
 * — the resumed id, once set, is the one every later turn must `--resume`.
 */
export function setClaudeSessionId(sessionId: string, claudeSessionId: string): void {
  setClaudeSessionIdStmt.run(claudeSessionId, sessionId);
}

// Ownership check used by ownershipGuard (Phase 2): resolves a session's owning teacher_id, or
// undefined if the session does not exist / the id shape is not this domain's.
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
