import { createHash } from 'node:crypto';
import { getQuestion, listTurnsForQuestion } from '../db/questions.js';
import { createOralTurn, type OralTurnRow } from '../db/questions.js';
import { getOralSession } from '../db/oralSessions.js';
import { getTurnSubmission, recordTurnSubmission } from '../db/turnSubmissions.js';
import { askNextQuestionLocked } from './questionEngine.js';
import { tryAcquireRoomLock, releaseRoomLock, RoomBusyError } from '../claude-cli/lock.js';
import { enqueueSpeechPrefetch } from './questionSpeechJobs.js';
import { createTurnJob, getTurnJob, type TurnJob } from './turnJobs.js';
import type { QuestionRow } from '../db/questions.js';
import {
  QuestionNotFoundError, QuestionNotInSessionError, SessionNotInProgressError, SubmissionConflictError,
} from './engineErrors.js';

export { QuestionNotFoundError, QuestionNotInSessionError, SessionNotInProgressError, SubmissionConflictError };

function fingerprintSubmission(params: { sessionId: string; questionId: string; inputMode: string; text: string }): string {
  return createHash('sha256')
    .update(`${params.sessionId}|${params.questionId}|${params.inputMode}|${params.text}`)
    .digest('hex');
}

function completionReasonFor(sessionId: string, nextQuestion: QuestionRow | null): string | null {
  return nextQuestion === null ? getOralSession(sessionId)?.completion_reason ?? null : null;
}

export type StartTurnResult =
  // The turn was already resolved without touching the CLI: a replay of an already-recorded
  // submission, or (below) a fast RoomBusyError before any job was created.
  | { kind: 'immediate'; turn: OralTurnRow; nextQuestion: QuestionRow | null; completionReason: string | null }
  // The turn row is committed; the examiner's next-question transition is running in the
  // background under `turnId` — poll/stream it via turnJobs.getTurnJob(turnId).
  | { kind: 'pending'; turn: OralTurnRow; turnId: string };

/** Runs the (possibly long-running) examiner CLI call for an already-committed turn and reports
 * its outcome on `job`. Always releases the room lock acquired by its caller, exactly once. */
async function runTurnJob(job: TurnJob, ctx: {
  sessionId: string; questionId: string; answeredQuestion: QuestionRow; turnId: string; fingerprint: string;
}): Promise<void> {
  try {
    const nextQuestion = await askNextQuestionLocked(ctx.sessionId, ctx.answeredQuestion);
    recordTurnSubmission({
      sessionId: ctx.sessionId, questionId: ctx.questionId, requestFingerprint: ctx.fingerprint,
      turnId: ctx.turnId, nextQuestionId: nextQuestion?.question_id ?? null, sessionCompleted: nextQuestion === null,
    });
    job.succeed({ nextQuestion, completionReason: completionReasonFor(ctx.sessionId, nextQuestion) });
    if (nextQuestion) enqueueSpeechPrefetch(nextQuestion);
    // End-to-end latency the client actually experiences for this turn (turn row committed ->
    // examiner CLI call + persist done) — the top of the stage breakdown chain, correlatable with
    // the '[claude-cli] examiner turn timing' / '[oral-turn] examiner turn resolved' log lines above
    // by sessionId, and with '[tts] speech job settled' by nextQuestion's question_id.
    console.info('[oral-turn] turn job settled', {
      sessionId: ctx.sessionId, turnId: ctx.turnId, questionId: ctx.questionId,
      nextQuestionId: nextQuestion?.question_id ?? null, total_ms: Date.now() - job.createdAt,
    });
  } catch (err) {
    // No HTTP response is in flight to throw into by this point — the failure lives entirely in
    // the job, for a stream subscriber (or submitOralTurn's wrapper below) to observe. Logged here
    // too: a client that never attaches to the SSE stream (closed tab, dropped connection) would
    // otherwise let a CLI failure vanish with zero trace once the job's retention window expires.
    console.error(`[oral-turn] examiner call failed for session ${ctx.sessionId} turn ${ctx.turnId}`, err);
    job.fail(err);
  } finally {
    releaseRoomLock(ctx.sessionId);
  }
}

/**
 * Records the teacher-relayed answer to one question (fast, synchronous) and either returns the
 * already-known result immediately (idempotent replay / crash-recovery retry of an unsettled
 * examiner call is still started fresh here, not replayed) or kicks off the examiner's next-move
 * CLI call in the background, returning a `turnId` the caller can track via turnJobs.
 *
 * Durable idempotency: the same (sessionId, questionId) with the same request content replays its
 * stored result instead of re-invoking the examiner — a retry of an already-committed submit never
 * creates a second turn or double-advances the session, even after the session itself has since
 * completed. A different request body for an already-submitted question is a genuine conflict, not
 * a retry, and is rejected before any CLI call.
 *
 * Crash recovery: the student's turn is written before the examiner is called, so a call that
 * fails afterward (CLI timeout, a malformed transition, an illegal action) leaves a turn with no
 * turn_submissions row yet. A same-content retry reuses that turn and re-asks the examiner instead
 * of rejecting the retry as already-answered or duplicating the turn — otherwise a single
 * transient examiner failure would permanently strand the session.
 *
 * Concurrency: the room lock is acquired synchronously (non-blocking — RoomBusyError if another
 * request already holds it) before this function returns, and released only once the background
 * CLI call settles — so a second, genuinely concurrent request for the same session still gets
 * `RoomBusyError` immediately, exactly as when the CLI call was awaited inline.
 */
export async function startOralTurn(params: {
  sessionId: string; questionId: string; inputMode: 'stt' | 'typed'; text: string;
}): Promise<StartTurnResult> {
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
    return { kind: 'immediate', turn, nextQuestion, completionReason: completionReasonFor(params.sessionId, nextQuestion) };
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
  } else if (session.status !== 'in_progress') {
    throw new SessionNotInProgressError(params.sessionId);
  }

  // Acquired BEFORE the (fresh-case) turn write, not just before the CLI call: a second, genuinely
  // concurrent request for the same session must fail fast here, before it can ever create its own
  // turn row for the same question — otherwise two racing requests could both pass the priorTurn
  // check above and each write a turn, breaking the one-turn-per-question invariant the rest of the
  // engine (idempotency lookups, review evidence) relies on. Matches the original synchronous
  // implementation, where turn creation ran strictly inside the single `withRoomLock` acquisition.
  if (!tryAcquireRoomLock(params.sessionId)) throw new RoomBusyError(params.sessionId);

  // Everything from here until the background job actually owns the lock (inside runTurnJob's own
  // try/finally) must release it on failure — createOralTurn is a synchronous DB write that can
  // throw (constraint violation, disk full, a busy WAL checkpoint), and an uncaught throw here
  // would leave the lock held forever with nothing left to ever call releaseRoomLock.
  let turn: OralTurnRow;
  let job: ReturnType<typeof createTurnJob>;
  try {
    turn = priorTurn ?? createOralTurn({ questionId: params.questionId, inputMode: params.inputMode, text: params.text });
    job = createTurnJob(turn.turn_id);
  } catch (err) {
    releaseRoomLock(params.sessionId);
    throw err;
  }
  void runTurnJob(job, {
    sessionId: params.sessionId, questionId: params.questionId, answeredQuestion: question,
    turnId: turn.turn_id, fingerprint,
  });
  return { kind: 'pending', turn, turnId: turn.turn_id };
}

/**
 * Synchronous convenience wrapper over `startOralTurn` for callers that want the full
 * turn-plus-next-question result in one await (internal engine callers, tests) rather than
 * tracking a background job — behaviorally identical to the pre-streaming implementation.
 */
export async function submitOralTurn(params: {
  sessionId: string; questionId: string; inputMode: 'stt' | 'typed'; text: string;
}): Promise<{ turn: OralTurnRow; nextQuestion: QuestionRow | null }> {
  const started = await startOralTurn(params);
  if (started.kind === 'immediate') return { turn: started.turn, nextQuestion: started.nextQuestion };
  const job = getTurnJob(started.turnId);
  if (!job) throw new Error(`turn job ${started.turnId} vanished before it could be awaited`);
  await job.settled;
  // Rethrows the original error object, not a reconstruction from job.failure's code/recoverable —
  // preserves instanceof, name, and stack for callers that pattern-match on the engine's typed
  // errors (e.g. e2e tests asserting err.name for SessionLeaseFencedError-style failures).
  if (job.state === 'failed') throw job.error;
  return { turn: started.turn, nextQuestion: job.result!.nextQuestion };
}
