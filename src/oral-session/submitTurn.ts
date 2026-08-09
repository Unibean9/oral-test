import { createHash } from 'node:crypto';
import { getQuestion, listTurnsForQuestion } from '../db/questions.js';
import { createOralTurn, type OralTurnRow } from '../db/questions.js';
import { getOralSession } from '../db/oralSessions.js';
import { getTurnSubmission, recordTurnSubmission } from '../db/turnSubmissions.js';
import { askNextQuestionLocked } from './questionEngine.js';
import { withRoomLock } from '../claude-cli/lock.js';
import { enqueueSpeechPrefetch } from './questionSpeechJobs.js';
import type { QuestionRow } from '../db/questions.js';

export class QuestionNotFoundError extends Error {
  constructor(questionId: string) { super(`question ${questionId} does not exist`); this.name = 'QuestionNotFoundError'; }
}
export class QuestionNotInSessionError extends Error {
  constructor(questionId: string, sessionId: string) { super(`question ${questionId} does not belong to session ${sessionId}`); this.name = 'QuestionNotInSessionError'; }
}
export class SessionNotInProgressError extends Error {
  constructor(sessionId: string) { super(`session ${sessionId} is not in_progress`); this.name = 'SessionNotInProgressError'; }
}
export class SubmissionConflictError extends Error {
  constructor(questionId: string) { super(`question ${questionId} was already submitted with different content`); this.name = 'SubmissionConflictError'; }
}

function fingerprintSubmission(params: { sessionId: string; questionId: string; inputMode: string; text: string }): string {
  return createHash('sha256')
    .update(`${params.sessionId}|${params.questionId}|${params.inputMode}|${params.text}`)
    .digest('hex');
}

/**
 * Records the teacher-relayed answer to one question, then asks the examiner for the next
 * conversational move (or completes the session). `inputMode` is required per the API contract —
 * the client/UI producing stt-vs-typed text is out of scope for this backend.
 *
 * Durable idempotency: the same (sessionId, questionId) with the same request content replays its
 * stored result instead of re-invoking the examiner — a timeout-retry of an already-committed
 * submit never creates a second turn or double-advances the session, even after the session
 * itself has since completed. A different request body for an already-submitted question is a
 * genuine conflict, not a retry, and is rejected before any CLI call.
 *
 * Crash recovery: the student's turn is written before the examiner is called, so a call that
 * fails afterward (CLI timeout, a malformed transition, an illegal action) leaves a turn with no
 * turn_submissions row yet. A same-content retry reuses that turn and re-asks the examiner instead
 * of rejecting the retry as already-answered or duplicating the turn — otherwise a single
 * transient examiner failure would permanently strand the session.
 *
 * The turn write and the next-question generation run inside ONE `withRoomLock` acquisition (via
 * `askNextQuestionLocked`, not the self-locking `askNextQuestion`) so a second, genuinely
 * concurrent request for the same session (arriving before the first has recorded its
 * turn_submissions row) gets `RoomBusyError` rather than racing it.
 */
export async function submitOralTurn(params: {
  sessionId: string; questionId: string; inputMode: 'stt' | 'typed'; text: string;
}): Promise<{ turn: OralTurnRow; nextQuestion: QuestionRow | null }> {
  const question = getQuestion(params.questionId);
  if (!question) throw new QuestionNotFoundError(params.questionId);
  if (question.session_id !== params.sessionId) throw new QuestionNotInSessionError(params.questionId, params.sessionId);

  const fingerprint = fingerprintSubmission(params);
  const existing = getTurnSubmission(params.sessionId, params.questionId);
  if (existing) {
    if (existing.request_fingerprint !== fingerprint) throw new SubmissionConflictError(params.questionId);
    const turn = listTurnsForQuestion(params.questionId).find((t) => t.turn_id === existing.turn_id);
    if (!turn) throw new Error(`stale turn_submissions row for question ${params.questionId}: turn ${existing.turn_id} not found`);
    const nextQuestion = existing.next_question_id ? getQuestion(existing.next_question_id) ?? null : null;
    return { turn, nextQuestion };
  }

  const session = getOralSession(params.sessionId);
  if (!session) throw new Error('session_not_found');

  const priorTurns = listTurnsForQuestion(params.questionId);
  const priorTurn = priorTurns[0];
  if (priorTurn) {
    // A turn was already committed for this question but no turn_submissions row exists (checked
    // above) — the examiner call or the submissions write itself must have failed after the turn
    // committed (CLI timeout, malformed transition, IllegalExaminerActionError). Reusing the same
    // turn instead of rejecting or duplicating it is what makes that failure recoverable rather
    // than a permanently stuck session.
    if (priorTurn.input_mode !== params.inputMode || priorTurn.text !== params.text) throw new SubmissionConflictError(params.questionId);
    if (session.status !== 'in_progress') throw new SessionNotInProgressError(params.sessionId);
    const result = await withRoomLock(params.sessionId, async () => {
      const nextQuestion = await askNextQuestionLocked(params.sessionId, question);
      recordTurnSubmission({
        sessionId: params.sessionId, questionId: params.questionId, requestFingerprint: fingerprint,
        turnId: priorTurn.turn_id, nextQuestionId: nextQuestion?.question_id ?? null, sessionCompleted: nextQuestion === null,
      });
      return { turn: priorTurn, nextQuestion };
    });
    if (result.nextQuestion) enqueueSpeechPrefetch(result.nextQuestion);
    return result;
  }

  if (session.status !== 'in_progress') throw new SessionNotInProgressError(params.sessionId);

  const result = await withRoomLock(params.sessionId, async () => {
    const turn = createOralTurn({ questionId: params.questionId, inputMode: params.inputMode, text: params.text });
    const nextQuestion = await askNextQuestionLocked(params.sessionId, question);
    recordTurnSubmission({
      sessionId: params.sessionId, questionId: params.questionId, requestFingerprint: fingerprint,
      turnId: turn.turn_id, nextQuestionId: nextQuestion?.question_id ?? null, sessionCompleted: nextQuestion === null,
    });
    return { turn, nextQuestion };
  });
  // Strictly after the lock has released — see questionEngine.ts's askNextQuestion for why.
  if (result.nextQuestion) enqueueSpeechPrefetch(result.nextQuestion);
  return result;
}
