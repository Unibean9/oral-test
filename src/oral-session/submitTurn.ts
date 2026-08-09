import { getQuestion } from '../db/questions.js';
import { createOralTurn, type OralTurnRow } from '../db/questions.js';
import { getOralSession } from '../db/oralSessions.js';
import { askNextQuestion } from './questionEngine.js';
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

/**
 * Records the teacher-relayed answer to one question, then asks the next one (or completes the
 * session if that was the last unmet slot). `inputMode` is required per Phase 4's API contract —
 * the client/UI producing stt-vs-typed text is out of scope for this backend.
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

  const turn = createOralTurn({ questionId: params.questionId, inputMode: params.inputMode, text: params.text });
  const nextQuestion = await askNextQuestion(params.sessionId);
  return { turn, nextQuestion };
}
