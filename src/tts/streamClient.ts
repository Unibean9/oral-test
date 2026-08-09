import { LIMITS, SUPPORTED_VOICES } from '../brainstorm/contracts.js';
import { SIDECAR_BUSY_STATUS, TtsBusyError, TtsUnavailableError } from './errors.js';

// Re-exported, not redeclared: both transports must raise the SAME class or `instanceof` checks in
// turnRunner silently stop matching for one of them. It is declared in errors.js, a dedicated
// module with no transport dependencies, so neither transport owns the other's import.
export { TtsBusyError };

const TTS_BASE_URL = process.env.TTS_SIDECAR_URL ?? 'http://127.0.0.1:8765';
const TTS_IDLE_TIMEOUT_MS = 10_000; // reset every time a new byte arrives
// Absolute cap for one sentence, even if data keeps arriving steadily. Shares LIMITS.ttsTimeoutMs
// with the non-streaming client: both now synthesize the same unit of work (one sentence, capped
// at SentenceSplitter's 220 chars), so two different budgets for it was drift, not design.
const TTS_HARD_TIMEOUT_MS = LIMITS.ttsTimeoutMs;
const MAX_FRAME_BYTES = 4 * 1024 * 1024;

const TAG_AUDIO = 0x00, TAG_END_OK = 0x01, TAG_END_ERROR = 0x02, TAG_BUSY = 0x03;

// Best-effort drift check between the backend's SUPPORTED_VOICES and the sidecar's own
// VOICE_PRESETS (tts-sidecar/app.py) — the only machine-checkable link across that TS/Python
// boundary, which otherwise has no shared schema. Never throws: the sidecar may not be up yet
// in some dev flows, and this must not block server startup either way.
export async function checkVoiceDriftAtBoot(): Promise<void> {
  try {
    const response = await fetch(`${TTS_BASE_URL}/health`, { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) return;
    const body = (await response.json()) as { voices?: string[] };
    const sidecarVoices = new Set(body.voices ?? []);
    const backendVoices = new Set(SUPPORTED_VOICES.map((v) => v.id));
    const missingInSidecar = [...backendVoices].filter((v) => !sidecarVoices.has(v));
    const missingInBackend = [...sidecarVoices].filter((v) => !backendVoices.has(v));
    if (missingInSidecar.length > 0 || missingInBackend.length > 0) {
      console.warn(
        `[tts] voice set mismatch between backend and sidecar — backend-only: [${missingInSidecar.join(', ')}], sidecar-only: [${missingInBackend.join(', ')}]`,
      );
    }
  } catch {
    // Sidecar unreachable at boot time — not this check's job to report that.
  }
}

export async function synthesizeStream(
  text: string,
  voiceId: string,
  onChunk: (chunk: Buffer) => void,
  externalSignal?: AbortSignal,
): Promise<void> {
  const controller = new AbortController();
  const onExternalAbort = () => controller.abort();
  // Checked before subscribing: an already-aborted signal never fires `abort` again, so a
  // listener alone would let a full 60s synthesis run to completion after the client is gone.
  if (externalSignal?.aborted) throw new TtsUnavailableError('TTS request aborted before it started');
  externalSignal?.addEventListener('abort', onExternalAbort);

  let idleTimer: NodeJS.Timeout = setTimeout(() => {}, 0);
  const armIdle = () => { clearTimeout(idleTimer); idleTimer = setTimeout(() => controller.abort(), TTS_IDLE_TIMEOUT_MS); };
  const hardDeadline = setTimeout(() => controller.abort(), TTS_HARD_TIMEOUT_MS);
  armIdle();

  try {
    let response: Response;
    try {
      response = await fetch(`${TTS_BASE_URL}/synthesize/stream`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text, voice_id: voiceId }),
        signal: controller.signal,
      });
    } catch (err) {
      throw new TtsUnavailableError(`TTS sidecar unreachable or timed out: ${(err as Error).message}`);
    }
    if (!response.ok) {
      const body = await response.text();
      // The waiter-cap-exhausted case (Requirements: "existing instant 503/busy-frame,
      // unchanged") now answers here, before any stream ever starts — the post-admission
      // "waited and the lock was still contended" case still arrives in-band as a 0x03 frame,
      // handled below once bytes are flowing. Both map to the same retryable error class.
      if (response.status === SIDECAR_BUSY_STATUS) throw new TtsBusyError(`TTS sidecar model is busy with another request: ${body}`);
      throw new TtsUnavailableError(`TTS sidecar returned ${response.status}: ${body}`);
    }
    if (!response.body) throw new TtsUnavailableError('TTS sidecar returned an empty body');

    const reader = response.body.getReader();
    // Chunks accumulate in a list and are concatenated only when a complete frame is available.
    // Re-concatenating the whole pending buffer on every socket read cost ~256 copies averaging
    // 2 MiB each for a single 4 MiB frame — hundreds of MiB of memcpy on the event loop, which
    // stalls every other room's SSE stream.
    let chunks: Buffer[] = [];
    let pendingLength = 0;
    let pending = Buffer.alloc(0);
    let terminated = false;
    /** Materializes at least `needed` bytes into `pending`, or returns false if not enough have arrived. */
    const coalesce = (needed: number): boolean => {
      if (pending.length >= needed) return true;
      if (pending.length + pendingLength < needed) return false;
      pending = Buffer.concat([pending, ...chunks], pending.length + pendingLength);
      chunks = [];
      pendingLength = 0;
      return pending.length >= needed;
    };
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        armIdle(); // reset the timeout on every received byte, not just once at fetch() time
        const chunk = Buffer.from(value);
        chunks.push(chunk);
        pendingLength += chunk.length;
        for (;;) {
          if (!coalesce(1)) break;
          const tag = pending[0];
          if (tag === TAG_END_OK) { terminated = true; pending = pending.subarray(1); break; }
          if (tag === TAG_END_ERROR) { throw new TtsUnavailableError('TTS sidecar reported synthesis failure'); }
          if (tag === TAG_BUSY) { throw new TtsBusyError('TTS sidecar model is busy with another request'); }
          if (tag !== TAG_AUDIO) throw new TtsUnavailableError(`TTS sidecar sent unknown frame tag ${tag}`);
          if (!coalesce(5)) break;
          const frameLen = pending.readUInt32BE(1);
          if (frameLen > MAX_FRAME_BYTES) throw new TtsUnavailableError('TTS audio frame exceeds size limit');
          if (!coalesce(5 + frameLen)) break;
          onChunk(pending.subarray(5, 5 + frameLen));
          pending = pending.subarray(5 + frameLen);
        }
        if (terminated) break;
      }
    } finally {
      // Cancelled unconditionally. Skipping cancel() on the success path left the response body
      // unconsumed and un-cancelled, so undici held the socket open — one per synthesized
      // sentence — whenever the sidecar did not immediately close after the terminator byte.
      try { await reader.cancel(); } catch { /* best-effort */ }
      try { reader.releaseLock(); } catch { /* already released by cancel() */ }
    }
    if (!terminated) throw new TtsUnavailableError('TTS sidecar stream ended without a terminator frame');
  } catch (err) {
    if (err instanceof TtsUnavailableError) throw err;
    if (controller.signal.aborted) throw new TtsUnavailableError('TTS sidecar stream timed out or was aborted');
    throw new TtsUnavailableError(`TTS stream failed: ${(err as Error).message}`);
  } finally {
    clearTimeout(idleTimer);
    clearTimeout(hardDeadline);
    externalSignal?.removeEventListener('abort', onExternalAbort);
  }
}
