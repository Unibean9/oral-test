export class TtsUnavailableError extends Error {}

/**
 * The sidecar's model lock was held by another request and the bounded wait timed out
 * (`/synthesize/stream`'s in-band `0x03` frame, or a `429` before the stream even started) —
 * retryable, unlike the other two subclasses below.
 */
export class TtsBusyError extends TtsUnavailableError {}

/** Any 4xx other than 429 — a deterministic rejection (bad/empty text, unknown voice_id). Never
 * retryable: the sidecar will reject the same input again. */
export class TtsBadRequestError extends TtsUnavailableError {}

/** 503 — the model has not finished loading yet (tts-sidecar/README.md's documented "still
 * booting" case). Not retryable on the same tight retry loop as TtsBusyError: this needs a much
 * longer backoff than a contended-lock retry, which belongs to the job scheduler, not here. */
export class TtsBootingError extends TtsUnavailableError {}

/** `/synthesize` and `/synthesize/stream` share this status for "waiter cap exhausted, or
 * admitted but the wait for the model lock timed out" — tts-sidecar/README.md's HTTP status
 * contract. */
export const SIDECAR_BUSY_STATUS = 429;
/** "Model not loaded" — still booting. Reserved distinctly from 429 so a boot-in-progress
 * sidecar doesn't consume a caller's busy-retry budget as if it were transient contention. */
export const SIDECAR_BOOTING_STATUS = 503;
