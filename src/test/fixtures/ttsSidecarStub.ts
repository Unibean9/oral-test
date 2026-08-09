import http from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Deterministic stand-in for tts-sidecar's `/synthesize/stream` (and `/health`), reproducing the
 * real service's status-code contract (429 busy / 503 booting / 422 bad request / 200 tagged
 * frames) so the retry-classification tests mean something. One instance per test file, started
 * once; per-check behavior is set via `forceStatus`/`setFrameDelayMs` and reset via
 * `resetCounters` — never a fresh server per check.
 */
export class TtsSidecarStub {
  private readonly server: http.Server;
  private forcedStatus: number | null = null;
  private frameDelayMs = 0;
  requestCount = 0;

  constructor() {
    this.server = http.createServer((req, res) => this.handle(req, res));
  }

  async listen(): Promise<string> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    const { port } = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  /** Persists until changed — every subsequent call (including retries) gets this status until
   * `forceStatus(null)` restores the normal 200-with-tagged-frames behavior. */
  forceStatus(status: number | null): void { this.forcedStatus = status; }
  setFrameDelayMs(ms: number): void { this.frameDelayMs = ms; }
  resetCounters(): void { this.requestCount = 0; }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, voices: ['vi-female-01', 'vi-male-01'] }));
      return;
    }
    if (req.method !== 'POST' || req.url !== '/synthesize/stream') {
      res.writeHead(404);
      res.end();
      return;
    }
    this.requestCount += 1;
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      if (this.forcedStatus !== null) {
        res.writeHead(this.forcedStatus, { 'content-type': 'text/plain' });
        res.end('stub forced status');
        return;
      }
      let text = 'stub';
      try { text = (JSON.parse(Buffer.concat(chunks).toString('utf8')).text as string) ?? text; } catch { /* keep default */ }
      const emit = () => {
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        const audio = Buffer.from(`wav-frame-for:${text}`);
        const len = Buffer.alloc(4);
        len.writeUInt32BE(audio.length);
        res.write(Buffer.concat([Buffer.from([0x00]), len, audio]));
        res.end(Buffer.from([0x01]));
      };
      if (this.frameDelayMs > 0) setTimeout(emit, this.frameDelayMs);
      else emit();
    });
  }
}
