import type { FastifyReply } from 'fastify';

export type SseWriteResult = 'ok' | 'dropped';

/**
 * Thin SSE framing over a Fastify reply's raw socket, with REAL backpressure: `write()`'s boolean
 * return value is honored, and a caller that wants strict ordering awaits the socket's `'drain'`
 * event before its next write — no `writableLength` polling. This is what lets the
 * per-subscriber cursor pump wait for a slow reader instead of flooding its write queue or
 * silently dropping audio to protect other subscribers.
 */
export class SseWriter {
  private seq = 0;
  private ended_ = false;
  private stalled_ = false;
  constructor(private readonly reply: FastifyReply, private readonly sessionId: string, private readonly streamId: string) {
    reply.raw.setHeader('content-type', 'text/event-stream; charset=utf-8');
    reply.raw.setHeader('cache-control', 'no-cache, no-transform');
    reply.raw.setHeader('connection', 'keep-alive');
    reply.raw.flushHeaders();
    // A write against an already-destroyed socket (client disconnected) emits 'error'
    // asynchronously; without a listener that is an uncaught exception.
    reply.raw.on('error', () => {});
  }

  /**
   * Writes one SSE event. If the socket reports its write queue is full (`write()` returns
   * `false`), waits for `'drain'` before resolving — so a caller writing multiple events in
   * sequence naturally paces itself to the reader's actual consumption rate. The wait is raced
   * against the socket closing, so a disconnect while waiting resolves promptly instead of
   * hanging forever. Returns `'dropped'` only if the stream had already ended before this call.
   */
  async event(name: string, data: Record<string, unknown>): Promise<SseWriteResult> {
    if (this.ended) {
      // Logged once per stream, not once per dropped event, so a mid-stream disconnect doesn't
      // warn once per remaining audio chunk.
      if (!this.stalled_) { this.stalled_ = true; console.warn(`[sse] dropping events after stream ended (first: '${name}')`); }
      return 'dropped';
    }
    if (/[\r\n]/.test(name)) throw new Error('sse_event_name_invalid');
    const seq = ++this.seq;
    const payload = JSON.stringify({ sessionId: this.sessionId, streamId: this.streamId, seq, ts: Date.now(), data });
    const wroteWithoutBackpressure = this.reply.raw.write(`id: ${seq}\nevent: ${name}\ndata: ${payload}\n\n`);
    if (!wroteWithoutBackpressure && !this.ended) {
      await new Promise<void>((resolve) => {
        const onDrain = () => { this.reply.raw.off('close', onClose); resolve(); };
        const onClose = () => { this.reply.raw.off('drain', onDrain); resolve(); };
        this.reply.raw.once('drain', onDrain);
        this.reply.raw.once('close', onClose);
      });
    }
    return 'ok';
  }

  error(code: string, recoverable: boolean): Promise<SseWriteResult> { return this.event('error', { code, recoverable }); }
  done(): void { if (!this.ended) { this.ended_ = true; this.reply.raw.end('event: done\ndata: [DONE]\n\n'); } }
  get lastSeq() { return this.seq; }
  // Also treat a destroyed/ended socket (client disconnect) as "ended" — the flag alone only
  // tracks whether done() ran, not whether the underlying connection is still writable.
  get ended() { return this.ended_ || this.reply.raw.destroyed || this.reply.raw.writableEnded; }
}
