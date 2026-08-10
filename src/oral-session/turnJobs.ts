// In-memory registry for the async examiner-transition work that follows a turn submission
// (askNextQuestionLocked's CLI call). POST /turns writes the turn row and returns immediately with
// a turnId; the actual CLI call runs in the background here, and GET /turns/:turnId/stream (SSE)
// reports its progress. A turn job has exactly one final result — unlike questionSpeechJobs.ts's
// SpeechJob, there are no incremental chunks to fan out to multiple live subscribers, so this has
// no subscribe/listener mechanism: callers just await `settled`.
import type { QuestionRow } from '../db/questions.js';
import { mapEngineError } from './engineErrors.js';

export type TurnJobState = 'running' | 'done' | 'failed';

export interface TurnJobResult { nextQuestion: QuestionRow | null; completionReason: string | null }
export interface TurnJobFailure { code: string; recoverable: boolean }

/** Retained briefly after settlement so a late-attaching SSE client (reconnect, slow open) can
 * still replay the outcome instead of finding nothing — matches the reconnect window a subscriber
 * could plausibly need, not a durability guarantee (this is memory-only, lost on process restart;
 * the durable fallback for an expired/missing job is turn_submissions, see oralTurnStream.ts). */
const JOB_RETENTION_MS = 5 * 60 * 1000;

export class TurnJob {
  state: TurnJobState = 'running';
  result?: TurnJobResult;
  failure?: TurnJobFailure;
  /** The original thrown error, kept alongside `failure`'s stable API code/recoverable pair so a
   * caller that awaits the result directly (submitOralTurn) can rethrow it with its real
   * type/name/stack intact instead of a code string reconstructed into a generic Error. */
  error?: unknown;
  readonly createdAt = Date.now();
  readonly settled: Promise<void>;
  private resolveSettled!: () => void;

  constructor(readonly turnId: string) {
    this.settled = new Promise((resolve) => { this.resolveSettled = resolve; });
  }

  succeed(result: TurnJobResult): void {
    if (this.state !== 'running') return;
    this.state = 'done';
    this.result = result;
    this.resolveSettled();
  }

  fail(err: unknown): void {
    if (this.state !== 'running') return;
    this.state = 'failed';
    this.error = err;
    const mapped = mapEngineError(err);
    this.failure = mapped ? { code: mapped.code, recoverable: mapped.recoverable } : { code: 'internal_error', recoverable: false };
    this.resolveSettled();
  }
}

const registry = new Map<string, TurnJob>();

export function createTurnJob(turnId: string): TurnJob {
  const job = new TurnJob(turnId);
  registry.set(turnId, job);
  job.settled.then(() => {
    setTimeout(() => {
      if (registry.get(turnId) === job) registry.delete(turnId);
    }, JOB_RETENTION_MS).unref();
  });
  return job;
}

export function getTurnJob(turnId: string): TurnJob | undefined {
  return registry.get(turnId);
}

/** Test-only: simulates the JOB_RETENTION_MS eviction firing early, so a test can exercise
 * oralTurnStream.ts's turn_submissions fallback without an actual 5-minute wait. */
export function _evictForTests(turnId: string): void {
  registry.delete(turnId);
}
