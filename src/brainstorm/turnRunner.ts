import * as db from '../db/sessions.js';
import type { OperationRow } from '../db/sessions.js';
import * as claude from '../claude-cli/spawn.js';
import * as roomLock from '../claude-cli/lock.js';
import * as ttsStream from '../tts/streamClient.js';
import { TtsUnavailableError } from '../tts/errors.js';
import { stripMarkdownForSpeech } from '../tts/textSanitize.js';
import * as sse from './sse.js';
import * as contract from './contracts.js';
import { SentenceSplitter } from './sentenceSplitter.js';
import { enqueue } from '../db/cloudSyncQueue.js';

// Each enqueue is independently try/caught and logged: a cloud outbox write failure must
// never turn a completed brainstorm turn into an error, and must never share a rollback
// boundary with finalizeOperation's own transaction.
function enqueueCloudSync(sessionId: string, kind: 'trace' | 'metadata'): void {
  try {
    enqueue(sessionId, kind);
  } catch (err) {
    console.error(`[cloud-sync] enqueue(${sessionId}, ${kind}) failed`, err);
  }
}

/**
 * Resolves after `ms`, or immediately if `signal` aborts first — so a client disconnect (or any
 * other audioAbort trigger) mid-backoff settles `ttsQueue` promptly instead of waiting out the
 * full delay. Never rejects: the caller re-checks `signal.aborted` itself after awaiting this.
 */
function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const onAbort = () => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

// Only fence against a hung run; a full claude child (120s) plus sequential TTS drain
// can legitimately take minutes, so this is generous.
// A cut-short drain aborts audio and settles as a recorded terminal operation, not silently.
const DEFAULT_RUN_DEADLINE_MS = 600_000;

// threading.Lock gives no fairness guarantee, so a holder can starve a waiter past one
// synthesis wait — retries absorb that, bounded by RUN_DEADLINE_MS, not a per-attempt timer.
// A sentence that exhausts retries latches audioFailed so later sentences no-op instead of retrying.
const DEFAULT_TTS_RETRY_ATTEMPTS = 2;
const DEFAULT_TTS_RETRY_DELAY_MS = 300;

// Mutable so a test can shrink these to make the deadline/retry timers assertable without a real
// multi-second wait — see `_setTimingForTests` below. Production code never calls the setter, so
// these stay at their defaults outside the test suite.
let RUN_DEADLINE_MS = DEFAULT_RUN_DEADLINE_MS;
let TTS_RETRY_ATTEMPTS = DEFAULT_TTS_RETRY_ATTEMPTS;
let TTS_RETRY_DELAY_MS = DEFAULT_TTS_RETRY_DELAY_MS;

/** Test-only. Pass `null` to restore the real defaults. */
export function _setTimingForTests(overrides: { runDeadlineMs?: number; ttsRetryAttempts?: number; ttsRetryDelayMs?: number } | null): void {
  RUN_DEADLINE_MS = overrides?.runDeadlineMs ?? DEFAULT_RUN_DEADLINE_MS;
  TTS_RETRY_ATTEMPTS = overrides?.ttsRetryAttempts ?? DEFAULT_TTS_RETRY_ATTEMPTS;
  TTS_RETRY_DELAY_MS = overrides?.ttsRetryDelayMs ?? DEFAULT_TTS_RETRY_DELAY_MS;
}

export type AudioMode = contract.AudioMode;

export class TurnRun {
  readonly sessionId: string;
  readonly turnId: string;
  readonly clientTurnId: string;
  readonly audioAbort = new AbortController();
  readonly runAbort = new AbortController();
  readonly done: Promise<void>;

  private readonly operation: OperationRow;
  private readonly text: string;
  private readonly audioMode: AudioMode;
  private readonly voiceId: string;
  private seq = 0;
  private readonly subscribers = new Set<sse.SseWriter>();
  private deadlineTimer: ReturnType<typeof setTimeout> | null = null;

  // Text/state replay buffer for reconnect. Deliberately excludes agent-audio-chunk/
  // agent-audio-done — those can be tens of MiB over a turn, and audio never resumes after a
  // reconnect anyway, so buffering it would cost memory for a replay that never happens.
  private readonly textLog: Array<{ seq: number; name: string; data: Record<string, unknown> }> = [];
  private textLogTruncated = false;
  private static readonly REPLAYABLE = new Set(['state', 'engine-step', 'agent-run-started', 'text-delta', 'text-done', 'error']);
  // A real turn is a few hundred events; this is a fence against a pathological one, not a
  // realistic budget. Once hit, further entries are dropped rather than growing the buffer
  // unboundedly — a reconnecting client past this point loses only the tail of a turn far
  // longer than any real facilitator reply.
  private static readonly TEXTLOG_MAX = 5_000;

  // Set by detach() only when ITS OWN abort() call is what actually transitions audioAbort from
  // not-aborted to aborted (never overwritten once true — AbortController fires once). Lets the
  // TTS retry/catch logic in runTurn() distinguish "audio stopped because the last listener left"
  // from every other abort trigger (run deadline, shutdown, backpressure truncation) without
  // guessing from the rejection alone. See Section D of the reconnect phase plan.
  private audioAbortedByDetach = false;

  constructor(sessionId: string, operation: OperationRow, text: string, audioMode: AudioMode) {
    this.sessionId = sessionId;
    this.turnId = operation.turn_id;
    this.clientTurnId = operation.client_turn_id;
    this.operation = operation;
    this.text = text;
    this.audioMode = audioMode;
    // Resolved once here, not per sentence: a synchronous SQLite read must not run once per
    // synthesized sentence on the audio path, and a session's voice cannot change mid-turn. Must
    // never throw — the constructor's failure modes are already delicate (see execute()'s
    // microtask comment below) — so a missing session or a retired/renamed voice id falls back to
    // DEFAULT_VOICE_ID rather than surfacing an error here.
    const sessionVoice = db.getSession(sessionId)?.voice_id;
    this.voiceId = sessionVoice && contract.isVoiceId(sessionVoice) ? sessionVoice : contract.DEFAULT_VOICE_ID;
    // Stops TTS the instant the run is told to stop for any reason (deadline, shutdown) — the
    // child is not the only thing a run deadline must bound.
    this.runAbort.signal.addEventListener('abort', () => this.audioAbort.abort());
    this.done = this.execute();
    // `done` is also observed by the route via `await run.done`, but that await is skipped on
    // some paths (the SseWriter-construction-throw case) and will be skipped by any future
    // caller that starts a run without immediately awaiting it. body() already turns every
    // failure into a recorded, terminal operation and never rethrows, so nothing here should
    // ever reject — this is a backstop against turning one bad turn into a process-wide
    // unhandledRejection (which server.ts treats as fatal and shuts the whole server down).
    this.done.catch((err) => console.error(`[turnRunner] run ${this.turnId} settled with an unexpected rejection`, err));
  }

  attach(writer: sse.SseWriter): void {
    this.subscribers.add(writer);
  }

  detach(writer: sse.SseWriter): void {
    this.subscribers.delete(writer);
    // No subscriber => no TTS. Audio is never buffered for a later replay, so with nobody left
    // to hear it there is nothing left to keep producing it for; the turn's text continues.
    if (this.subscribers.size === 0) {
      // Only claim credit for the abort if this call is actually what triggers it — if
      // audioAbort was already aborted for some other reason (deadline, shutdown, truncation),
      // this abort() call is a no-op and must not relabel that earlier reason as "detach".
      if (!this.audioAbort.signal.aborted) this.audioAbortedByDetach = true;
      this.audioAbort.abort();
    }
  }

  private anySubscriberBackedUp(): boolean {
    for (const w of this.subscribers) if (w.backedUp) return true;
    return false;
  }

  /** Assigns the seq once, here, and forwards to every live subscriber. */
  emit(name: string, data: Record<string, unknown>): number {
    const seq = ++this.seq;
    if (TurnRun.REPLAYABLE.has(name)) this.pushTextLog(seq, name, data);
    for (const w of this.subscribers) if (!w.ended) w.writeFrame(seq, name, data);
    return seq;
  }

  private pushTextLog(seq: number, name: string, data: Record<string, unknown>): void {
    if (this.textLog.length >= TurnRun.TEXTLOG_MAX) { this.textLogTruncated = true; return; }
    this.textLog.push({ seq, name, data });
  }

  /**
   * Writes every buffered text/state event with `seq > fromSeq` into `writer`. MUST be called
   * synchronously, with zero `await` before the caller's subsequent `attach(writer)` — otherwise
   * a live event could land in the gap and be duplicated or lost. Skips replaying `error` events
   * coded `audio_unavailable`/`audio_truncated` — a client that just reconnected shouldn't be
   * re-shown the audio error that dropped it (live emission to other subscribers is unaffected).
   */
  replayInto(writer: sse.SseWriter, fromSeq: number): number {
    for (const entry of this.textLog) {
      if (entry.seq <= fromSeq) continue;
      if (entry.name === 'error') {
        const code = (entry.data as { code?: unknown }).code;
        if (code === 'audio_unavailable' || code === 'audio_truncated') continue;
      }
      if (!writer.ended) writer.writeFrame(entry.seq, entry.name, entry.data);
    }
    return this.seq;
  }

  get lastSeq(): number {
    return this.seq;
  }

  private stopTimers(): void {
    if (this.deadlineTimer) clearTimeout(this.deadlineTimer);
    this.deadlineTimer = null;
  }

  private async execute(): Promise<void> {
    // Yield one microtask before any real work — including the synchronous parts of
    // withRoomLock/body — runs. A caller that constructs a run and then synchronously attaches
    // a subscriber (the route does exactly this) is thereby guaranteed to win the race: without
    // this, a fully-synchronous failure path (operation already claimed) could emit its
    // error/done frames and tear itself down before the route ever attaches its writer, hanging
    // the response forever.
    await Promise.resolve();
    try {
      await roomLock.withRoomLock(this.sessionId, () => this.body());
    } catch (err) {
      if (err instanceof roomLock.RoomBusyError) {
        // Narrow race: an artifact-generation request holds the room lock for this session. The
        // operation row was already written `accepted` by the route before this run started and
        // never reached `processing`, so this is safe to fail unconditionally. `room_busy`/
        // recoverable — this is the same transient condition the pre-refactor route answered
        // with 409 room_busy, just discovered one step later.
        db.failOperation(this.turnId, 'room_busy', 0);
        this.emit('error', { code: 'room_busy', recoverable: true });
        this.emit('state', { state: 'idle' });
      } else {
        // body() itself catches every failure it can name and always settles the operation; a
        // throw reaching here means withRoomLock (not body()) failed unexpectedly. Record it
        // rather than rethrow — an uncaught rejection here would reach server.ts's
        // unhandledRejection handler and take the whole process down for one bad turn.
        console.error(`[turnRunner] run ${this.turnId} aborted before body() could run`, err);
        db.failOperation(this.turnId, 'turn_failed', 0);
        this.emit('error', { code: 'turn_failed', recoverable: false });
        this.emit('state', { state: 'idle' });
      }
    } finally {
      this.stopTimers();
      for (const w of this.subscribers) w.done();
      this.subscribers.clear();
      if (registry.get(this.sessionId) === this) registry.delete(this.sessionId);
    }
  }

  private async body(): Promise<void> {
    let settled = false;
    // Marks settled only AFTER fn() returns without throwing: `finalizeOperation` can itself
    // throw (its compare-and-set found the row already out of `processing`), and if that flips
    // `settled` before the write actually lands, the failure path's own
    // `settle(() => failOperation(...))` below would then
    // be a silent no-op — leaving the row exactly as non-terminal as the bug this latch exists
    // to prevent.
    const settle = (fn: () => void) => { if (settled) return; fn(); settled = true; };
    try {
      const acquired = db.markOperationProcessing(this.turnId);
      if (!acquired) throw new OperationNotProcessingError();
      this.deadlineTimer = setTimeout(() => this.runAbort.abort(), RUN_DEADLINE_MS);
      this.deadlineTimer.unref();
      await this.runTurn(settle);
    } catch (err) {
      // Reachable from markOperationProcessing failing (OperationNotProcessingError, thrown
      // before any timer is armed) and from every failure inside runTurn — one classification,
      // one terminal write.
      this.audioAbort.abort();
      let reason: string;
      if (err instanceof OperationNotProcessingError) {
        reason = 'operation_not_processing';
      } else if (err instanceof claude.ClientGoneError) {
        // Kept as the API/test-contract code even though runAbort now also fires it
        // on a run deadline or shutdown, not only a literal HTTP disconnect.
        reason = 'client_disconnected';
      } else {
        reason = 'turn_failed';
      }
      settle(() => db.failOperation(this.turnId, reason, this.seq + 1));
      this.emit('error', { code: reason, recoverable: reason === 'client_disconnected' });
      this.emit('state', { state: 'idle' });
    } finally {
      // Belt and braces. failOperation's `WHERE status IN ('accepted','processing')` already
      // makes this a no-op after a completed turn; the `settle` latch above is the primary
      // guard, this SQL guard is the backstop.
      settle(() => db.failOperation(this.turnId, 'turn_failed', 0));
    }
  }

  private async runTurn(settle: (fn: () => void) => void): Promise<void> {
    let ttsQueue: Promise<void> = Promise.resolve();
    let audioFailed = false;
    let audioTruncated = false;
    let audioBytesEmitted = 0;
    const splitter = new SentenceSplitter();
    try {
      // A SQLite write that can throw `operation_not_found` — one of the two ways a turn could
      // die before any work started; caught by this same try's catch below, same as every other
      // failure in this body.
      const messageId = db.reserveAssistantMessage(this.turnId);
      const truncateAudio = () => {
        if (!audioTruncated) { audioTruncated = true; audioFailed = true; this.emit('error', { code: 'audio_truncated', recoverable: true }); }
        this.audioAbort.abort();
      };
      const synthesizeOnce = (sentence: string) => ttsStream.synthesizeStream(sentence, this.voiceId, (chunk: Buffer) => {
        if (this.audioAbort.signal.aborted) return;
        // Backpressure: audio is the only high-volume payload here and it is optional. If no
        // subscriber is draining fast enough, drop the rest of this turn's audio rather than
        // queueing tens of MiB in the process heap on its behalf.
        if (this.anySubscriberBackedUp()) return truncateAudio();
        audioBytesEmitted += chunk.length;
        if (audioBytesEmitted > contract.LIMITS.turnAudioBytes) return truncateAudio();
        this.emit('agent-audio-chunk', { messageId, encoding: 'audio/wav', audioBase64: chunk.toString('base64') });
      }, this.audioAbort.signal);
      /**
       * Serializes one synthesis attempt behind every earlier one and owns the shared
       * failure policy for the streaming path.
       *
       * The sidecar's own bounded wait (tts-sidecar/app.py) absorbs most single-collision
       * cases before ever raising `TtsBusyError` — but not the starvation case (see
       * `DEFAULT_TTS_RETRY_ATTEMPTS`'s comment above), where this retry loop is load-bearing,
       * not a purely-hypothetical backstop.
       */
      const enqueueAudio = (attempt: () => Promise<void>) => {
        ttsQueue = ttsQueue.then(async () => {
          if (audioFailed || this.audioAbort.signal.aborted) return;
          for (let attemptsLeft = TTS_RETRY_ATTEMPTS; ; attemptsLeft--) {
            try {
              await attempt();
              return;
            } catch (err) {
              // Retries the TtsUnavailableError base class, not just its TtsBusyError subclass —
              // slower hardware can miss a timeout without lock contention, and one hiccup
              // shouldn't permanently silence audio for the rest of the turn.
              const retryable = err instanceof TtsUnavailableError && attemptsLeft > 0 && !this.audioAbort.signal.aborted;
              if (!retryable) {
                // audioTruncated already aborted audioAbort, which makes the in-flight transport
                // reject; without this guard one truncation surfaces as two contradictory events.
                const alreadyReported = audioTruncated;
                // A normal client disconnect also aborts audioAbort, causing the same rejection
                // as a real failure — without this check it wrongly emits audio_unavailable and
                // skews the failure metric for a non-TTS disconnect.
                if (!this.audioAbortedByDetach) {
                  audioFailed = true;
                  if (!alreadyReported) {
                    console.error(`[turnRunner] turn ${this.turnId} audio_unavailable after retries exhausted:`, err);
                    this.emit('error', { code: 'audio_unavailable', recoverable: true });
                  }
                }
                return;
              }
            }
            await abortableDelay(TTS_RETRY_DELAY_MS, this.audioAbort.signal);
            // Aborted mid-backoff (client disconnect, run deadline, shutdown):
            // settle `ttsQueue` now rather than spending the delay on a room nobody is
            // listening to anymore. No `audio_unavailable` here — the abort's own path (or
            // `truncateAudio`) already accounts for why audio stopped.
            if (this.audioAbort.signal.aborted) return;
          }
        });
      };
      // stripMarkdownForSpeech runs here, not inside synthesizeOnce: a sentence that becomes
      // empty after stripping (e.g. a lone "**" or a code fence) must never reach TTS at all,
      // rather than round-tripping to the sidecar as an empty-text 400.
      const enqueueSentence = (sentence: string) => {
        const spoken = stripMarkdownForSpeech(sentence);
        if (spoken) enqueueAudio(() => synthesizeOnce(spoken));
      };
      const emitStep = (step: number) => { db.setSessionEngineStep(this.sessionId, step); this.emit('engine-step', { step, focusNodeId: contract.ENGINE_NODES[step] }); };
      this.emit('state', { state: 'processing' }); emitStep(0);
      this.emit('agent-run-started', { messageId, replyToMessageId: this.operation.user_message_id }); emitStep(1);
      let startedSpeaking = false;
      // this.runAbort.signal kills the `claude` child on a run deadline or shutdown — never on
      // client disconnect, which is now audioAbort's job alone.
      const result = await claude.streamTurn(this.sessionId, this.text, (delta: string) => {
        if (!startedSpeaking) { startedSpeaking = true; this.emit('state', { state: 'agent-speaking' }); emitStep(2); }
        this.emit('text-delta', { messageId, delta });
        if (this.audioMode === 'streaming') for (const sentence of splitter.push(delta)) enqueueSentence(sentence);
      }, this.runAbort.signal);
      if (!result.parseOk || !result.state) throw new Error('invalid_private_state');
      emitStep(3);
      settle(() => db.finalizeOperation({ operation: this.operation, text: result.spokenText, phase: result.state!.phase, technique: result.state!.technique, diagnosis: result.state!.diagnosis, traceEntry: result.state!.trace_entry, finalSeq: this.seq + 1 }));
      enqueueCloudSync(this.sessionId, 'trace');
      enqueueCloudSync(this.sessionId, 'metadata');
      emitStep(4);
      if (!startedSpeaking) { this.emit('state', { state: 'agent-speaking' }); emitStep(5); }
      this.emit('text-done', { messageId, text: result.spokenText, phaseKey: result.state.phase });
      if (this.audioMode === 'streaming') {
        for (const sentence of splitter.finish()) enqueueSentence(sentence);
      }
      await ttsQueue;
      this.emit('agent-audio-done', { messageId });
      emitStep(6); this.emit('state', { state: 'idle' }); emitStep(7);
      db.setOperationFinalSeq(this.turnId, this.seq);
    } finally {
      // Draining the TTS queue must still happen before body()'s outer catch classifies a
      // failure and before execute()'s finally tells subscribers `done` — so this stays a
      // `finally` here rather than folding into the outer one. Any error thrown above (or by
      // `finalizeOperation`, whose compare-and-set can itself throw `operation_not_processing_
      // before_finalize`) propagates to body()'s catch after this finally runs; nothing is
      // swallowed here.
      this.audioAbort.abort();
      await ttsQueue.catch(() => {});
    }
  }
}

/** Thrown internally when `markOperationProcessing` fails to transition `accepted` -> `processing`. Never escapes `body()`. */
class OperationNotProcessingError extends Error {
  constructor() { super('operation_not_processing'); this.name = 'OperationNotProcessingError'; }
}

const registry = new Map<string, TurnRun>();

/** The live run for a session, if any. Used by the GET stream reconnect route to attach. */
export function getRun(sessionId: string): TurnRun | undefined {
  return registry.get(sessionId);
}

/** Registers and immediately starts a turn. The caller must attach a subscriber synchronously afterward — see execute()'s comment on the ordering guarantee. */
export function startTurn(sessionId: string, operation: OperationRow, text: string, audioMode: AudioMode): TurnRun {
  const run = new TurnRun(sessionId, operation, text, audioMode);
  registry.set(sessionId, run);
  return run;
}

/** Aborts every live run and waits, bounded, for them to settle. */
export async function drainAll(timeoutMs: number): Promise<void> {
  const runs = [...registry.values()];
  if (runs.length === 0) return;
  for (const run of runs) run.runAbort.abort();
  await Promise.race([
    Promise.allSettled(runs.map((run) => run.done)),
    new Promise<void>((resolve) => { const t = setTimeout(resolve, timeoutMs); t.unref(); }),
  ]);
}

/** Test-only: empties the registry without running any run's teardown, so a leaked run from one test cannot fail an unrelated later one. */
export function _resetForTests(): void {
  registry.clear();
}
