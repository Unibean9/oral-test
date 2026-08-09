import { db } from './connection.js';

/**
 * Durable idempotency record for one submitted student answer, keyed by (session_id,
 * question_id) — a question can only ever be answered once, so that pair is naturally the
 * operation key. A retry carrying the same request_fingerprint replays this row's stored outcome
 * instead of re-invoking the examiner; a different fingerprint for an already-recorded question is
 * a genuine conflict, not a retry.
 */
export interface TurnSubmissionRow {
  session_id: string;
  question_id: string;
  request_fingerprint: string;
  turn_id: string;
  next_question_id: string | null;
  session_completed: number;
  created_at: string;
}

const selectStmt = db.prepare('SELECT * FROM turn_submissions WHERE session_id = ? AND question_id = ?');
export function getTurnSubmission(sessionId: string, questionId: string): TurnSubmissionRow | undefined {
  return selectStmt.get(sessionId, questionId) as TurnSubmissionRow | undefined;
}

const insertStmt = db.prepare(
  `INSERT INTO turn_submissions (session_id, question_id, request_fingerprint, turn_id, next_question_id, session_completed, created_at)
   VALUES (?, ?, ?, ?, ?, ?, ?)`,
);
export function recordTurnSubmission(params: {
  sessionId: string; questionId: string; requestFingerprint: string; turnId: string;
  nextQuestionId: string | null; sessionCompleted: boolean;
}): void {
  insertStmt.run(
    params.sessionId, params.questionId, params.requestFingerprint, params.turnId,
    params.nextQuestionId, params.sessionCompleted ? 1 : 0, new Date().toISOString(),
  );
}
