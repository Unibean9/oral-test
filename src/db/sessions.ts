import { v4 as uuidv4 } from 'uuid';
import { db } from './connection.js';
import { seam } from '../brainstorm/testSeam.js';

export interface SessionRow {
  session_id: string;
  room_id: string;
  name: string;
  created_by_teacher_id: string;
  created_at: string;
  current_phase: string;
  engine_step: number;
  status: string;
  trace_may_be_incomplete: number;
  audio_failure_count: number;
  artifact_errors: string | null;
  wrapped_at: string | null;
  voice_id: string;
}

export interface TraceRow {
  turn_index: number;
  phase: string;
  technique: string | null;
  diagnosis: string | null;
  trace_entry: string | null;
  created_at: string;
}

export interface TurnRow {
  message_id: string | null;
  turn_id: string | null;
  turn_index: number;
  role: string;
  text: string;
  created_at: string;
}

// owner_instance_id/owner_pid/lease_expires_at columns still physically exist in the schema
// (migration v5) but are dead: the lease/heartbeat/watchdog protocol they backed was removed in
// favor of a boot-time pidfile single-writer lock (db/singleWriterLock.ts). Deliberately not
// declared here — nothing in the write path reads or writes them anymore.
export interface OperationRow {
  turn_id: string; session_id: string; client_turn_id: string;
  status: 'accepted' | 'processing' | 'completed' | 'failed' | 'interrupted'; turn_index: number;
  user_message_id: string; assistant_message_id: string | null; error_code: string | null; final_seq: number;
  created_at: string; updated_at: string; completed_at: string | null;
}

const insertOperation = db.prepare("INSERT INTO turn_operations (turn_id, session_id, client_turn_id, status, turn_index, user_message_id, created_at, updated_at) VALUES (?, ?, ?, 'accepted', ?, ?, ?, ?)");
const insertUserTurn = db.prepare("INSERT INTO turns (session_id, turn_index, role, text, created_at, message_id, turn_id) VALUES (?, ?, 'user', ?, ?, ?, ?)");
const selectOperationByClientTurn = db.prepare('SELECT * FROM turn_operations WHERE session_id = ? AND client_turn_id = ?');
const selectActiveOperationForSession = db.prepare("SELECT turn_id FROM turn_operations WHERE session_id = ? AND status IN ('accepted','processing') LIMIT 1");
const selectOperationByTurnId = db.prepare('SELECT * FROM turn_operations WHERE turn_id = ?');

export const createOrLoadOperation = db.transaction((sessionId: string, clientTurnId: string, text: string): { operation: OperationRow; created: boolean } => {
  const existing = selectOperationByClientTurn.get(sessionId, clientTurnId) as OperationRow | undefined;
  if (existing) return { operation: existing, created: false };
  const active = selectActiveOperationForSession.get(sessionId);
  if (active) throw new Error('turn_in_progress');
  const turnId = uuidv4(), userMessageId = uuidv4(), turnIndex = nextTurnIndex(sessionId), now = new Date().toISOString();
  insertOperation.run(turnId, sessionId, clientTurnId, turnIndex, userMessageId, now, now);
  insertUserTurn.run(sessionId, turnIndex, text, now, userMessageId, turnId);
  return { operation: selectOperationByTurnId.get(turnId) as OperationRow, created: true };
});

const selectActiveOperation = db.prepare("SELECT * FROM turn_operations WHERE session_id = ? AND status IN ('accepted','processing') ORDER BY created_at DESC LIMIT 1");
// An interrupted operation is a durable recovery result, not live work.  It remains queryable
// by its client key but must not prevent a new turn after a process restart.
export function getActiveOperation(sessionId: string): OperationRow | undefined { return selectActiveOperation.get(sessionId) as OperationRow | undefined; }

const selectLatestInterruptedOperation = db.prepare("SELECT * FROM turn_operations AS interrupted WHERE session_id = ? AND status = 'interrupted' AND NOT EXISTS (SELECT 1 FROM turn_operations AS newer WHERE newer.session_id = interrupted.session_id AND newer.created_at > interrupted.created_at) ORDER BY updated_at DESC LIMIT 1");
// Surface restart recovery only until another turn is accepted. A later turn supersedes the
// old interruption in the reload projection while the interrupted row remains queryable by key.
export function getLatestInterruptedOperation(sessionId: string): OperationRow | undefined { return selectLatestInterruptedOperation.get(sessionId) as OperationRow | undefined; }

const selectLatestFailedOperation = db.prepare("SELECT * FROM turn_operations AS f WHERE session_id = ? AND status = 'failed' AND NOT EXISTS (SELECT 1 FROM turn_operations AS newer WHERE newer.session_id = f.session_id AND newer.created_at > f.created_at) ORDER BY updated_at DESC LIMIT 1");
// Same "only until another turn supersedes it" rule as the interrupted projection above. Folded
// into the reload snapshot so POST /turns' 409 and GET /sessions/:id stop contradicting each
// other; the snapshot's `state` deliberately stays 'idle', because nothing is running.
export function getLatestFailedOperation(sessionId: string): OperationRow | undefined { return selectLatestFailedOperation.get(sessionId) as OperationRow | undefined; }

const markOperationProcessingStmt = db.prepare("UPDATE turn_operations SET status = 'processing', updated_at = ? WHERE turn_id = ? AND status = 'accepted'");
/**
 * Compare-and-set transition `accepted` -> `processing`. Returns whether this call won the
 * transition — a `false` means the operation was already claimed (by a concurrent call, in
 * practice unreachable given the registry + this same status guard, but checked rather than
 * assumed).
 */
export function markOperationProcessing(turnId: string): boolean {
  const result = markOperationProcessingStmt.run(new Date().toISOString(), turnId);
  return result.changes > 0;
}

const selectAssistantMessageId = db.prepare('SELECT assistant_message_id FROM turn_operations WHERE turn_id = ?');
const setAssistantMessageId = db.prepare('UPDATE turn_operations SET assistant_message_id = ?, updated_at = ? WHERE turn_id = ?');
function reserveAssistantMessageImpl(turnId: string): string {
  const existing = selectAssistantMessageId.get(turnId) as { assistant_message_id: string | null } | undefined;
  if (!existing) throw new Error('operation_not_found');
  if (existing.assistant_message_id) return existing.assistant_message_id;
  const id = uuidv4(); setAssistantMessageId.run(id, new Date().toISOString(), turnId); return id;
}
// Seamed so a test can make this SQLite write throw, which is one of the two ways a turn can die
// between markOperationProcessing and the route's try block — see routes/brainstormSessions.ts.
export const reserveAssistantMessage = seam(reserveAssistantMessageImpl);

const insertFacilitatorTurn = db.prepare("INSERT INTO turns (session_id, turn_index, role, text, created_at, message_id, turn_id) VALUES (?, ?, 'facilitator', ?, ?, ?, ?)");
const insertTrace = db.prepare('INSERT INTO trace (session_id, turn_index, phase, technique, diagnosis, trace_entry, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
const updateSessionPhase = db.prepare('UPDATE sessions SET current_phase = ? WHERE session_id = ?');
// The only remaining source of a `processing` row leaving that status outside these very
// statements is `recoverInterruptedOperations()` at server boot, which runs top-level before any
// route (or TurnRun) exists and so is unreachable once a route is live. The `result.changes === 0`
// checks below are kept as defensive assertions against future programming errors, not because
// of any live race today.
const completeOperationStmt = db.prepare(
  `UPDATE turn_operations SET status = 'completed', assistant_message_id = ?, final_seq = ?, updated_at = ?, completed_at = ?
   WHERE turn_id = ? AND status = 'processing'`,
);

export const finalizeOperation = db.transaction((params: { operation: OperationRow; text: string; phase: string; technique: string | null; diagnosis: string | null; traceEntry: string | null; finalSeq: number }) => {
  const now = new Date().toISOString();
  const operation = selectOperationByTurnId.get(params.operation.turn_id) as OperationRow;
  const assistantMessageId = operation.assistant_message_id ?? uuidv4();
  const result = completeOperationStmt.run(assistantMessageId, params.finalSeq, now, now, operation.turn_id);
  // Defensive assertion (see comment above): do not write the facilitator turn/trace at all if
  // the row somehow left `processing` out from under this call.
  if (result.changes === 0) throw new Error('operation_not_processing_before_finalize');
  insertFacilitatorTurn.run(operation.session_id, operation.turn_index, params.text, now, assistantMessageId, operation.turn_id);
  insertTrace.run(operation.session_id, operation.turn_index, params.phase, params.technique, params.diagnosis, params.traceEntry, now);
  updateSessionPhase.run(params.phase, operation.session_id);
  return assistantMessageId;
});

const failOperationStmt = db.prepare(
  `UPDATE turn_operations SET status = 'failed', error_code = ?, final_seq = ?, updated_at = ?
   WHERE turn_id = ? AND status IN ('accepted','processing')`,
);
export function failOperation(turnId: string, code: string, finalSeq = 0): void {
  failOperationStmt.run(code, finalSeq, new Date().toISOString(), turnId);
}

const setFinalSeqStmt = db.prepare(
  `UPDATE turn_operations SET final_seq = ?, updated_at = ? WHERE turn_id = ? AND status = 'processing'`,
);
export function setOperationFinalSeq(turnId: string, finalSeq: number): void {
  setFinalSeqStmt.run(finalSeq, new Date().toISOString(), turnId);
}

const recoverInterruptedStmt = db.prepare("UPDATE turn_operations SET status = 'interrupted', error_code = 'turn_interrupted', updated_at = ? WHERE status IN ('accepted','processing')");
export function recoverInterruptedOperations(): void { recoverInterruptedStmt.run(new Date().toISOString()); }

const insertSessionStmt = db.prepare(
  `INSERT INTO sessions (session_id, room_id, name, created_by_teacher_id, created_at, current_phase, status, voice_id) VALUES (?, ?, ?, ?, ?, 'framing', 'active', ?)`,
);
export function createSession(params: { sessionId: string; roomId: string; name: string; createdByTeacherId: string; voiceId: string }): void {
  insertSessionStmt.run(params.sessionId, params.roomId, params.name, params.createdByTeacherId, new Date().toISOString(), params.voiceId);
}

const selectSessionStmt = db.prepare(`SELECT * FROM sessions WHERE session_id = ?`);
export function getSession(sessionId: string): SessionRow | undefined {
  return selectSessionStmt.get(sessionId) as SessionRow | undefined;
}

const setSessionStatusStmt = db.prepare(`UPDATE sessions SET status = ? WHERE session_id = ?`);
export function setSessionStatus(sessionId: string, status: string): void { setSessionStatusStmt.run(status, sessionId); }

const setSessionEngineStepStmt = db.prepare('UPDATE sessions SET engine_step = ? WHERE session_id = ?');
export function setSessionEngineStep(sessionId: string, step: number): void { setSessionEngineStepStmt.run(step, sessionId); }

const nextTurnIndexStmt = db.prepare(`SELECT COALESCE(MAX(turn_index), 0) AS maxIdx FROM turns WHERE session_id = ?`);
export function nextTurnIndex(sessionId: string): number {
  const row = nextTurnIndexStmt.get(sessionId) as { maxIdx: number };
  return row.maxIdx + 1;
}

const selectTraceStmt = db.prepare(`SELECT turn_index, phase, technique, diagnosis, trace_entry, created_at FROM trace WHERE session_id = ? ORDER BY turn_index ASC`);
export function getTrace(sessionId: string): TraceRow[] {
  return selectTraceStmt.all(sessionId) as TraceRow[];
}

const selectTranscriptStmt = db.prepare(`SELECT message_id, turn_id, turn_index, role, text, created_at FROM turns WHERE session_id = ? ORDER BY turn_index ASC, CASE role WHEN 'user' THEN 0 ELSE 1 END ASC`);
export function getTranscript(sessionId: string): TurnRow[] {
  return selectTranscriptStmt.all(sessionId) as TurnRow[];
}

export function getPublicTranscript(sessionId: string) {
  return getTranscript(sessionId).map((row) => ({ messageId: row.message_id ?? `${row.turn_index}-${row.role}`, role: row.role === 'user' ? 'user' : 'agent', text: row.text, turnId: row.turn_id ?? '', createdAt: row.created_at }));
}

// `audio_failure_count` and `artifact_errors` columns still physically exist in the schema (they
// backed the cloud metadata `insights` block, removed in the YAGNI slimdown) but are dormant:
// nothing in the write path reads or writes them anymore. No migration drops them.

const setWrappedAtStmt = db.prepare('UPDATE sessions SET wrapped_at = ? WHERE session_id = ?');
export function setSessionWrapped(sessionId: string): void {
  setWrappedAtStmt.run(new Date().toISOString(), sessionId);
}
