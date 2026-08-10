// Typed errors for the oral-session turn/question engine, plus a shared mapping to a stable API
// error code. Owning the error classes here (rather than in submitTurn.ts, which needs to import
// this module's mapping for async turn-job failures) avoids a submitTurn.ts <-> turnJobs.ts import
// cycle; submitTurn.ts re-exports these for existing call sites.
import { RoomBusyError } from '../claude-cli/lock.js';
import { CourseHasNoBlueprintsError } from './startSession.js';
import { IllegalExaminerActionError } from './questionEngine.js';
import { ExaminerSkillVersionMismatchError, ExaminerCliVersionMismatchError } from '../claude-cli/spawn.js';
import { SessionLeaseFencedError } from '../db/oralSessions.js';

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

export interface MappedEngineError { code: string; status: number; recoverable: boolean }

const MAPPINGS: Array<[new (...args: never[]) => Error, MappedEngineError]> = [
  [CourseHasNoBlueprintsError, { code: 'course_not_found', status: 404, recoverable: false }],
  [QuestionNotFoundError, { code: 'question_not_found', status: 404, recoverable: false }],
  [QuestionNotInSessionError, { code: 'question_not_in_session', status: 422, recoverable: false }],
  [SessionNotInProgressError, { code: 'session_not_in_progress', status: 409, recoverable: false }],
  [SubmissionConflictError, { code: 'submission_conflict', status: 409, recoverable: false }],
  [IllegalExaminerActionError, { code: 'examiner_illegal_action', status: 502, recoverable: false }],
  [RoomBusyError, { code: 'session_busy', status: 409, recoverable: false }],
  [SessionLeaseFencedError, { code: 'session_lease_fenced', status: 409, recoverable: true }],
  [ExaminerSkillVersionMismatchError, { code: 'examiner_skill_version_mismatch', status: 409, recoverable: false }],
  [ExaminerCliVersionMismatchError, { code: 'examiner_cli_version_mismatch', status: 409, recoverable: false }],
];

/** Undefined for anything not one of the engine's typed errors — callers fall back to their own
 * generic-error handling (a 500 for routes, an 'internal_error' code for SSE). */
export function mapEngineError(err: unknown): MappedEngineError | undefined {
  if (!(err instanceof Error)) return undefined;
  for (const [ctor, mapped] of MAPPINGS) if (err instanceof ctor) return mapped;
  return undefined;
}
