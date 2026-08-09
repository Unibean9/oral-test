import { DEFAULT_VOICE_ID } from '../contracts.js';
import { synthesizeStream } from '../tts/streamClient.js';
import { TtsBadRequestError, TtsBootingError, TtsUnavailableError } from '../tts/errors.js';
import { stripMarkdownForSpeech } from '../tts/textSanitize.js';
import type { QuestionRow } from '../db/questions.js';

export type JobState = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
export type JobPriority = 'foreground' | 'background';
type SettleOutcome = 'done' | 'failed' | 'cancelled';
type JobEvent = { type: 'chunk' | SettleOutcome };

// Byte/TTL/count budget for the completed-job cache. Provisional defaults, not measured against
// real chunk sizes/session volume — no live sidecar was reachable to benchmark against. Test-
// overridable via `_setCacheConfigForTests`.
const DEFAULT_CACHE_CONFIG = {
  maxCacheBytes: 256 * 1024 * 1024,
  cacheTtlMs: 30 * 60 * 1000,
  maxCacheCount: 200,
};
export const cacheConfig = { ...DEFAULT_CACHE_CONFIG };
export function _setCacheConfigForTests(overrides: Partial<typeof DEFAULT_CACHE_CONFIG> | null): void {
  Object.assign(cacheConfig, overrides ?? DEFAULT_CACHE_CONFIG);
}

// Retryable-error backoff: jittered, bounded by a max elapsed budget rather than a fixed
// attempt count with no ceiling.
const RETRY_BASE_MS = 200;
const RETRY_MAX_ELAPSED_MS = 8_000;

/**
 * One question's synthesized-audio job. `chunks` is append-only — subscribers each track their
 * own read cursor into it (see `pumpSpeechJob`) rather than the job pushing data at them, so one
 * slow subscriber can never block another or the producer.
 */
export class SpeechJob {
  state: JobState = 'queued';
  priority: JobPriority;
  readonly chunks: Buffer[] = [];
  readonly abort = new AbortController();
  failureCode?: string;
  bytes = 0;
  retryCount = 0;
  sidecarCallCount = 0;
  readonly createdAt = Date.now();
  runningAt?: number;
  firstByteAt?: number;
  firstChunkAt?: number;
  doneAt?: number;
  readonly settled: Promise<void>;
  private resolveSettled!: () => void;
  private readonly listeners = new Set<(evt: JobEvent) => void>();

  constructor(readonly questionId: string, readonly questionText: string, priority: JobPriority) {
    this.priority = priority;
    this.settled = new Promise((resolve) => { this.resolveSettled = resolve; });
  }

  get subscriberCount(): number { return this.listeners.size; }

  subscribe(onEvent: (evt: JobEvent) => void): () => void {
    this.listeners.add(onEvent);
    return () => { this.listeners.delete(onEvent); };
  }

  private emit(evt: JobEvent): void { for (const listener of this.listeners) listener(evt); }

  pushChunk(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.bytes += chunk.length;
    if (this.firstChunkAt === undefined) this.firstChunkAt = Date.now();
    this.emit({ type: 'chunk' });
  }

  settle(outcome: SettleOutcome, failureCode?: string): void {
    if (this.state !== 'queued' && this.state !== 'running') return;
    this.state = outcome;
    this.failureCode = failureCode;
    this.doneAt = Date.now();
    this.emit({ type: outcome });
    this.resolveSettled();
  }
}

/**
 * Wires a subscriber to a job via a pull-model cursor: this async loop advances `cursor` through
 * `job.chunks` at whatever pace `handlers.onChunk` (typically an SSE write awaiting real
 * backpressure) can sustain, and only re-checks for more work when woken by the job's own
 * "chunk pushed" / terminal-state notification. This is the single code path for both a live
 * subscriber and a late-attaching one replaying an already-`done` job — there is no separate
 * "replay" branch, since `chunks`/`state` already hold everything either caller needs.
 */
export function pumpSpeechJob(
  job: SpeechJob,
  handlers: {
    onChunk: (chunk: Buffer, index: number) => Promise<void>;
    onDone: () => Promise<void>;
    onFailed: (code: string | undefined) => Promise<void>;
    onCancelled: () => Promise<void>;
  },
): { stop: () => void; finished: Promise<void> } {
  let cursor = 0;
  let pumping = false;
  let stopped = false;
  let wake: () => void = () => {};
  let resolveFinished!: () => void;
  const finished = new Promise<void>((resolve) => { resolveFinished = resolve; });

  const runPump = async (): Promise<void> => {
    if (pumping || stopped) return;
    pumping = true;
    try {
      for (;;) {
        while (cursor < job.chunks.length) {
          if (stopped) return;
          await handlers.onChunk(job.chunks[cursor], cursor);
          cursor += 1;
        }
        if (stopped) return;
        if (job.state === 'done') { await handlers.onDone(); return; }
        if (job.state === 'failed') { await handlers.onFailed(job.failureCode); return; }
        if (job.state === 'cancelled') { await handlers.onCancelled(); return; }
        await new Promise<void>((resolve) => { wake = resolve; });
      }
    } catch (err) {
      // A dead/erroring subscriber (e.g. a write against a socket that closed mid-write) must
      // never surface as an unhandled rejection — server.ts treats that as fatal. Tear this one
      // subscriber down; the job and any other subscribers are unaffected.
      console.error(`[tts] subscriber pump failed for question ${job.questionId}`, err);
      stopped = true;
      unsubscribe();
    } finally {
      pumping = false;
      resolveFinished();
    }
  };

  const unsubscribe = job.subscribe(() => { wake(); void runPump(); });
  void runPump();
  return {
    stop: () => {
      stopped = true;
      unsubscribe();
      wake(); // release a pending "wait for next event" await so the loop can observe `stopped` and exit
    },
    finished,
  };
}

const registry = new Map<string, SpeechJob>();
const queue: SpeechJob[] = [];
let activeJob: SpeechJob | null = null;

function insertByPriority(job: SpeechJob): void {
  if (job.priority === 'background') { queue.push(job); return; }
  const idx = queue.findIndex((j) => j.priority === 'background');
  if (idx === -1) queue.push(job); else queue.splice(idx, 0, job);
}

function promoteToForeground(job: SpeechJob): void {
  const idx = queue.indexOf(job);
  if (idx !== -1) queue.splice(idx, 1);
  job.priority = 'foreground';
  insertByPriority(job);
}

function isRetryable(err: unknown): boolean {
  // TtsBusyError and bare network/timeout TtsUnavailableError are retryable; the two more
  // specific subclasses (deterministic 4xx, still-booting) never are.
  return err instanceof TtsUnavailableError && !(err instanceof TtsBadRequestError) && !(err instanceof TtsBootingError);
}

const ERROR_CODES = new Map<Function, string>([
  [TtsBadRequestError, 'tts_bad_request'],
  [TtsBootingError, 'tts_booting'],
  [TtsUnavailableError, 'tts_unavailable'],
]);
function errorCode(err: unknown): string {
  if (err instanceof Error) {
    for (const [ctor, code] of ERROR_CODES) if (err instanceof (ctor as new (...a: never[]) => Error)) return code;
  }
  return 'unknown_error';
}

/**
 * Runs one synthesis attempt. On a retryable failure, this frees the scheduler slot (returns
 * with the job back in `state: 'queued'`) and schedules its own re-attempt after a backoff delay
 * instead of sleeping in place — otherwise a background prefetch backing off would hold up a
 * foreground request queued behind it for up to `RETRY_MAX_ELAPSED_MS`.
 */
async function runSynthesis(job: SpeechJob): Promise<void> {
  job.state = 'running';
  job.runningAt ??= Date.now();
  const startedAt = job.runningAt;
  job.sidecarCallCount += 1;
  try {
    await synthesizeStream(job.questionText, DEFAULT_VOICE_ID, (chunk) => job.pushChunk(chunk), job.abort.signal, {
      onFirstByte: () => { if (job.firstByteAt === undefined) job.firstByteAt = Date.now(); },
    });
    job.settle('done');
    logSettlement(job, 'done');
  } catch (err) {
    if (job.abort.signal.aborted) { job.settle('cancelled'); logSettlement(job, 'cancelled'); return; }
    const elapsed = Date.now() - startedAt;
    // A retry after any audio has already reached subscribers cannot be replayed cleanly —
    // `chunks` is append-only and subscribers have already consumed a prefix of it — so this
    // job fails outright rather than risking a corrupted second stream appended after the
    // first. In practice the sidecar's busy/network failures surface before any frame is
    // emitted (tts-sidecar/app.py's worker either fully succeeds or emits only the busy tag),
    // so this mostly never triggers.
    const retryable = isRetryable(err) && job.chunks.length === 0 && elapsed < RETRY_MAX_ELAPSED_MS;
    if (!retryable) {
      job.settle('failed', errorCode(err));
      logSettlement(job, 'failed');
      return;
    }
    job.retryCount += 1;
    job.state = 'queued';
    const backoffMs = Math.max(0, Math.min(RETRY_BASE_MS * job.retryCount + Math.random() * RETRY_BASE_MS, RETRY_MAX_ELAPSED_MS - elapsed));
    setTimeout(() => {
      if (job.state !== 'queued') return; // settled (e.g. abort/reset) while waiting — nothing to resume
      if (job.abort.signal.aborted) { job.settle('cancelled'); logSettlement(job, 'cancelled'); return; }
      insertByPriority(job);
      kickScheduler();
    }, backoffMs).unref();
  }
}

/**
 * One structured `console.info` line per settled job — plain-console,
 * matching this repo's existing logging style, no new dependency.
 */
function logSettlement(job: SpeechJob, outcome: SettleOutcome): void {
  console.info('[tts] speech job settled', {
    questionId: job.questionId,
    priority: job.priority,
    queue_ms: job.runningAt !== undefined ? job.runningAt - job.createdAt : undefined,
    sidecar_ttfb_ms: job.firstByteAt !== undefined && job.runningAt !== undefined ? job.firstByteAt - job.runningAt : undefined,
    first_frame_ms: job.firstChunkAt !== undefined && job.runningAt !== undefined ? job.firstChunkAt - job.runningAt : undefined,
    total_ms: job.doneAt !== undefined ? job.doneAt - job.createdAt : undefined,
    // Always 'miss': this line only fires for a job that actually ran a synthesis (queued ->
    // running -> settled here). A cache hit — an already-`done` job `ensureJob` returns straight
    // back to a new caller — attaches that caller to the SAME job object without re-entering the
    // scheduler, so it never produces a second settlement event; a hit/attached-running request
    // is observable instead via the job's `subscriberCount` at attach time, not this log line.
    cache_status: 'miss',
    outcome,
    bytes: job.bytes,
    retry_count: job.retryCount,
  });
}

/** Enqueues a background-priority synthesis for a question nobody has asked to hear yet, so a
 * later foreground speech request can serve from cache. Swallows every error — a prefetch must
 * never fail or delay the question-creation response it rides along with. */
export function enqueueSpeechPrefetch(question: QuestionRow): void {
  try {
    ensureJob(question.question_id, stripMarkdownForSpeech(question.question_text), 'background');
  } catch (err) {
    console.error(`[tts] prefetch enqueue failed for ${question.question_id}`, err);
  }
}

function kickScheduler(): void {
  if (activeJob || queue.length === 0) return;
  const job = queue.shift()!;
  activeJob = job;
  void runSynthesis(job)
    .catch((err) => {
      // runSynthesis never rejects in normal operation (every branch calls job.settle()); this
      // is a last-resort guard so a truly unexpected throw still can't become an unhandled
      // rejection and take the whole process down (server.ts's unhandledRejection handler exits).
      console.error(`[tts] runSynthesis for question ${job.questionId} threw unexpectedly`, err);
      if (job.state !== 'done' && job.state !== 'failed' && job.state !== 'cancelled') job.settle('failed', 'internal_error');
    })
    .finally(() => {
      // Guard identity: a retry's own setTimeout (see runSynthesis) can re-enter the scheduler
      // for the same job while this .finally is still pending, so only the invocation that is
      // still actually active may clear the slot.
      if (activeJob === job) activeJob = null;
      kickScheduler();
    });
}

const MAX_PENDING_BACKGROUND = 50;

/** Bounds unbounded growth from repeated prefetch (e.g. a long session asking many questions
 * back-to-back): once too many background jobs are waiting, the oldest queued one is dropped
 * rather than letting `queue`/`registry` grow without limit. Foreground jobs are never dropped. */
function evictQueueOverflow(): void {
  while (queue.filter((j) => j.priority === 'background').length > MAX_PENDING_BACKGROUND) {
    const idx = queue.findIndex((j) => j.priority === 'background');
    if (idx === -1) break;
    const [dropped] = queue.splice(idx, 1);
    dropped.settle('cancelled', 'queue_overflow');
  }
}

function currentCachedBytes(): number {
  let total = 0;
  for (const job of registry.values()) total += job.bytes;
  return total;
}

/** Evicts done jobs by TTL, then by byte budget, then by count cap (LRU by doneAt) — checked on
 * every admission. Failed/cancelled jobs are never here: settleAndFinalize removes them
 * immediately on settlement, they are never cached. */
function evictIfNeeded(): void {
  const now = Date.now();
  const doneJobs = () => [...registry.values()]
    .filter((j) => j.state === 'done')
    .sort((a, b) => (a.doneAt ?? 0) - (b.doneAt ?? 0));

  for (const job of doneJobs()) {
    if (job.doneAt !== undefined && now - job.doneAt >= cacheConfig.cacheTtlMs) registry.delete(job.questionId);
  }
  while (currentCachedBytes() > cacheConfig.maxCacheBytes) {
    const oldest = doneJobs()[0];
    if (!oldest) break;
    registry.delete(oldest.questionId);
  }
  while (registry.size > cacheConfig.maxCacheCount) {
    const oldest = doneJobs()[0];
    if (!oldest) break;
    registry.delete(oldest.questionId);
  }
}

/**
 * Returns the shared job for `questionId`, creating one if none is queued/running/done.
 * `priority: 'foreground'` against an existing queued background job promotes it to the front of
 * the scheduler queue instead of starting a second synthesis. Never rejects — synthesis failures
 * live in the returned job's `state`, not in a rejected promise.
 */
export function ensureJob(questionId: string, questionText: string, priority: JobPriority): SpeechJob {
  evictIfNeeded();
  const existing = registry.get(questionId);
  if (existing) {
    if (priority === 'foreground' && existing.priority === 'background') {
      existing.priority = 'foreground';
      if (existing.state === 'queued') promoteToForeground(existing);
    }
    return existing;
  }
  const job = new SpeechJob(questionId, questionText, priority);
  registry.set(questionId, job);
  job.settled.then(() => {
    // 'done' stays cached (subject to evictIfNeeded's budget); a fresh request for a
    // failed/cancelled question must start a brand-new job, not replay the failure forever.
    // Identity-checked: a later job for the same questionId must not be deleted by an earlier
    // one's settlement callback.
    if (job.state !== 'done' && registry.get(questionId) === job) registry.delete(questionId);
  });
  insertByPriority(job);
  evictQueueOverflow();
  kickScheduler();
  return job;
}

/** Aborts a job that lost its last subscriber while still foreground and not yet settled — never
 * a job with other subscribers, and never a background (prefetch) job, which has no subscriber
 * to lose in the first place. */
export function maybeAbortOrphanedForeground(job: SpeechJob): void {
  if (job.priority === 'foreground' && job.subscriberCount === 0 && (job.state === 'queued' || job.state === 'running')) {
    job.abort.abort();
  }
}

/** Attaches an SSE subscriber to `job`, writing its audio chunks and terminal event through
 * `writer`. `finished` resolves once the pump has delivered a terminal event (or been stopped);
 * the route awaits it before returning so Fastify sees the reply as already handled (mirroring
 * this repo's other raw-response routes: `return reply` after the raw stream has ended). `detach`
 * is the route's `reply.raw.on('close', ...)` handler — it unsubscribes the pump and aborts the
 * job if it is now an orphaned foreground job. */
export function attachSseSubscriber(
  job: SpeechJob,
  writer: import('../tts/sseWriter.js').SseWriter,
): { finished: Promise<void>; detach: () => void } {
  const pump = pumpSpeechJob(job, {
    onChunk: async (chunk, index) => {
      await writer.event('speech-audio-chunk', { chunkIndex: index, mimeType: 'audio/wav', audioBase64: chunk.toString('base64') });
    },
    onDone: async () => {
      await writer.event('speech-audio-done', { totalChunks: job.chunks.length });
      writer.done();
    },
    onFailed: async (code) => {
      await writer.error(code ?? 'tts_failed', true);
      writer.done();
    },
    onCancelled: async () => {
      await writer.error('tts_cancelled', true);
      writer.done();
    },
  });
  return {
    finished: pump.finished,
    detach: () => {
      pump.stop();
      maybeAbortOrphanedForeground(job);
    },
  };
}

/** Aborts every job, awaits their settlement, and clears the registry — async (unlike a
 * synchronous `Map.clear()`) so no job's internal retry/backoff work leaks into a later test. */
export async function _resetForTests(): Promise<void> {
  const jobs = [...registry.values()];
  queue.length = 0;
  for (const job of jobs) {
    job.abort.abort();
    // A job still 'queued' here was never dequeued into runSynthesis (which we just emptied out
    // from under it), so nothing will ever call job.settle() on it — settle it directly or
    // `settled` below hangs forever.
    if (job.state === 'queued') job.settle('cancelled');
  }
  await Promise.allSettled(jobs.map((job) => job.settled));
  registry.clear();
  activeJob = null;
  _setCacheConfigForTests(null);
}

/**
 * Shutdown hook: aborts every in-flight/queued job's `AbortController` and waits (bounded by
 * `timeoutMs`) for their settlement, so a hung speech job can never hold the process open past
 * server.ts's `FORCED_EXIT_MS` deadline. Unlike `_resetForTests`, this does not clear the
 * registry — the process is exiting regardless, there is nothing left to reuse it for.
 */
export async function abortAllAndDrain(timeoutMs: number): Promise<void> {
  const jobs = [...registry.values()].filter((job) => job.state === 'queued' || job.state === 'running');
  if (jobs.length === 0) return;
  for (const job of jobs) job.abort.abort();
  await Promise.race([
    Promise.allSettled(jobs.map((job) => job.settled)),
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs).unref()),
  ]);
}
