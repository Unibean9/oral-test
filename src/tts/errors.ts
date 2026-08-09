export class TtsUnavailableError extends Error {}

/**
 * Distinct from a synthesis failure: the sidecar's model lock was held by another request, so the
 * caller may retry instead of abandoning audio for the rest of the turn.
 *
 * Lives in this dedicated module (not streamClient.ts, where it started, nor the now-deleted
 * client.ts) so BOTH transports can import it without either one owning the other's dependency.
 * streamClient.ts re-exports it, so existing importers are unaffected.
 */
export class TtsBusyError extends TtsUnavailableError {}

/**
 * The sidecar's `/synthesize` answers a held/contended model lock (waiter cap exhausted, or
 * admitted but the wait timed out) with this; `/synthesize/stream` uses a 0x03 frame for the
 * post-admission case. 503 is reserved for "model not loaded" (still booting) so a boot-in-
 * progress sidecar doesn't consume the caller's busy-retry budget as if it were transient.
 */
export const SIDECAR_BUSY_STATUS = 429;
