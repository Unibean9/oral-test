import { v4 as uuidv4 } from 'uuid';
import { db } from './connection.js';

export const ORAL_SESSION_ID_PREFIX = 'os_';
export const RETENTION_DAYS = 180;

export type OralSessionStatus = 'in_progress' | 'completed' | 'reviewed' | 'approved';

export interface AssessmentSessionRow {
  session_id: string;
  blueprint_id: string;
  teacher_id: string;
  student_code: string;
  status: OralSessionStatus;
  started_at: string;
  ended_at: string | null;
  expires_at: string;
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
  `UPDATE assessment_sessions SET status = 'completed', ended_at = ? WHERE session_id = ? AND status = 'in_progress'`,
);
/** Compare-and-set: only an `in_progress` session can transition to `completed` here. */
export function endOralSession(sessionId: string): boolean {
  const result = endSessionStmt.run(new Date().toISOString(), sessionId);
  return result.changes > 0;
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
