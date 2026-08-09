import { getQuestion, listTurnsForQuestion } from '../db/questions.js';
import { createOralTurn, type OralTurnRow } from '../db/questions.js';
import { getOralSession } from '../db/oralSessions.js';
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
export class QuestionAlreadyAnsweredError extends Error {
  constructor(questionId: string) { super(`question ${questionId} already has a recorded answer`); this.name = 'QuestionAlreadyAnsweredError'; }
}

/**
 * Records the teacher-relayed answer to one question, then asks the next one (or completes the
 * session if that was the last unmet slot). `inputMode` is required per Phase 4's API contract —
 * the client/UI producing stt-vs-typed text is out of scope for this backend.
 *
 * Both the turn write and the next-question generation run inside ONE `withRoomLock` acquisition
 * (via `askNextQuestionLocked`, not the self-locking `askNextQuestion`) — splitting them across
 * two lock acquisitions let a client's timeout-retry of the same `questionId` land between them:
 * the retry would record a second turn for an already-answered question, then generate a
 * question for the NEXT slot instead of re-returning the still-unanswered one from the first
 * attempt, silently leaving that question with no turn ever recorded. The explicit
 * already-answered check below closes the same gap for a retry that arrives with no concurrent
 * request in flight at all (so `withRoomLock` alone wouldn't have caught it).
 */
export async function submitOralTurn(params: {
  sessionId: string; questionId: string; inputMode: 'stt' | 'typed'; text: string;
}): Promise<{ turn: OralTurnRow; nextQuestion: QuestionRow | null }> {
  const session = getOralSession(params.sessionId);
  if (!session) throw new Error('session_not_found');
  if (session.status !== 'in_progress') throw new SessionNotInProgressError(params.sessionId);

  const question = getQuestion(params.questionId);
  if (!question) throw new QuestionNotFoundError(params.questionId);
  if (question.session_id !== params.sessionId) throw new QuestionNotInSessionError(params.questionId, params.sessionId);
  if (listTurnsForQuestion(params.questionId).length > 0) throw new QuestionAlreadyAnsweredError(params.questionId);

  const result = await withRoomLock(params.sessionId, async () => {
    const turn = createOralTurn({ questionId: params.questionId, inputMode: params.inputMode, text: params.text });
    const nextQuestion = await askNextQuestionLocked(params.sessionId);
    return { turn, nextQuestion };
  });
  // Strictly after the lock has released — see questionEngine.ts's askNextQuestion for why.
  if (result.nextQuestion) enqueueSpeechPrefetch(result.nextQuestion);
  return result;
}
