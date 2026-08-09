import type { FastifyReply } from 'fastify';
import { LIMITS } from './contracts.js';

/**
 * How much unflushed data may sit in the socket's write queue before this writer starts
 * refusing optional payloads. `write()`'s return value used to be discarded entirely, so a
 * client that stopped reading (backgrounded tab, throttled link) caused a whole turn's audio —
 * up to LIMITS.turnAudioBytes, ~43 MiB once base64-encoded — to accumulate in the Node heap
 * while TTS kept producing.
 */
const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;

export class SseWriter {
  private seq = 0;
  private ended_ = false;
  private stalled_ = false;
  constructor(private readonly reply: FastifyReply, private readonly sessionId: string, private readonly turnId: string) {
    reply.raw.setHeader('content-type', 'text/event-stream; charset=utf-8');
    reply.raw.setHeader('cache-control', 'no-cache, no-transform');
    reply.raw.setHeader('connection', 'keep-alive');
    reply.raw.flushHeaders();
    // A write against an already-destroyed socket (client disconnected mid-turn) emits
    // 'error' asynchronously; without a listener that is an uncaught exception.
    reply.raw.on('error', () => {});
  }
  event(name: string, data: Record<string, unknown>): number {
    // Logged once per stream, not once per dropped event, so a mid-turn disconnect doesn't
    // warn once per remaining text-delta token.
    if (this.ended) {
      if (!this.stalled_) { this.stalled_ = true; console.warn(`[sse] dropping events after stream ended (first: '${name}')`); }
      return -1;
    }
    const seq = ++this.seq;
    const payload = JSON.stringify({ sessionId: this.sessionId, turnId: this.turnId, seq, ts: Date.now(), data });
    if (Buffer.byteLength(payload, 'utf8') > LIMITS.sseEventBytes || /[\r\n]/.test(name)) throw new Error('sse_event_too_large');
    this.reply.raw.write(`event: ${name}\ndata: ${payload}\n\n`);
    return seq;
  }
  error(code: string, recoverable: boolean): number { return this.event('error', { code, recoverable }); }
  /**
   * Writes a frame at a seq assigned by the caller, instead of this writer's own counter.
   * Used by `TurnRun` (`brainstorm/turnRunner.ts`), which owns the seq for the whole run — a
   * per-writer counter is meaningless once a run can have zero or more than one subscriber.
   */
  writeFrame(seq: number, name: string, data: Record<string, unknown>): void {
    if (this.ended) {
      if (!this.stalled_) { this.stalled_ = true; console.warn(`[sse] dropping events after stream ended (first: '${name}')`); }
      return;
    }
    const payload = JSON.stringify({ sessionId: this.sessionId, turnId: this.turnId, seq, ts: Date.now(), data });
    if (Buffer.byteLength(payload, 'utf8') > LIMITS.sseEventBytes || /[\r\n]/.test(name)) throw new Error('sse_event_too_large');
    // `id:` is what makes `Last-Event-ID` work on browser reconnect (WHATWG SSE spec); the demo
    // client instead relies on the `seq` already carried inside `data` (query-param based
    // reconnect, since the initial stream is a POST — EventSource can't do that), but this line
    // costs nothing and is correct per spec either way. Field order does not matter to the spec.
    this.reply.raw.write(`id: ${seq}\nevent: ${name}\ndata: ${payload}\n\n`);
  }
  done(): void { if (!this.ended) { this.ended_ = true; this.reply.raw.end('event: done\ndata: [DONE]\n\n'); } }
  get lastSeq() { return this.seq; }
  /**
   * True when the consumer is not draining fast enough. Producers of optional, high-volume
   * payloads (audio) check this and stop rather than letting the write queue grow without bound;
   * text events are small and always sent so the transcript stays complete.
   */
  get backedUp(): boolean { return this.reply.raw.writableLength > MAX_BUFFERED_BYTES; }
  // Also treat a destroyed/ended socket (client disconnect) as "ended" — the flag alone
  // only tracks whether done() ran, not whether the underlying connection is still writable.
  get ended() { return this.ended_ || this.reply.raw.destroyed || this.reply.raw.writableEnded; }
}
