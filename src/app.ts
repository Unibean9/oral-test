import Fastify, { type FastifyInstance } from "fastify";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { oralAuthRoutes } from "./routes/oralAuth.js";
import { blueprintRoutes } from "./routes/blueprints.js";
import { oralSessionRoutes } from "./routes/oralSessions.js";
import { oralSpeechRoutes } from "./routes/oralSpeech.js";
import { reviewRoutes } from "./routes/reviews.js";
import { registerAuthPlugin } from "./auth/jwt.js";
import { apiError, apiOk } from "./contracts.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const PORT = Number(process.env.PORT ?? 3001);
// Internal tool, no auth layer — must never be reachable beyond localhost.
export const HOST = "127.0.0.1";

function resolveAllowedOrigins(): string[] {
  const origins = (
    process.env.BRAINSTORM_ALLOWED_ORIGINS ??
    "http://localhost:3000,http://127.0.0.1:3000,http://localhost:5173,http://127.0.0.1:5173"
  )
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  const allNormalized = origins.every((origin) => {
    try {
      return new URL(origin).origin === origin;
    } catch {
      return false;
    }
  });
  if (origins.length === 0 || !allNormalized) {
    throw new Error("BRAINSTORM_ALLOWED_ORIGINS must contain one or more normalized exact origins");
  }
  return origins;
}

/**
 * Builds the fully-wired Fastify instance without binding a port, so the HTTP surface —
 * the Origin/Host guard, the error envelope, the 404 shape, route validation — can be
 * exercised with `app.inject()` in tests. Everything with a process-level side effect
 * (migration recovery, the cloud-sync poller, signal handlers, listen) stays in server.ts.
 */
export async function buildApp(options: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? true });
  const allowedOrigins = resolveAllowedOrigins();

  // The demo console at /demo is served from this same origin, so its own fetches carry an
  // Origin header the configured allowlist has no reason to mention. Accept it implicitly.
  const selfOrigins = new Set([`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`]);
  const isAllowedOrigin = (origin: string) => allowedOrigins.includes(origin) || selfOrigins.has(origin);
  // Host values that legitimately reach a loopback-bound listener. Anything else means the
  // request arrived via a hostname that merely resolves to 127.0.0.1 — DNS rebinding.
  const allowedHosts = new Set([
    `127.0.0.1:${PORT}`, `localhost:${PORT}`, `[::1]:${PORT}`,
    "127.0.0.1", "localhost", "[::1]",
  ]);

  app.addHook("onRequest", async (request, reply) => {
    // With no auth layer, Origin/Host checks are the only thing standing between this API and a
    // page on any origin the teacher happens to have open. CORS response headers alone do not
    // stop a cross-origin POST — the browser blocks reading the RESPONSE, but the write already
    // happened — and they do nothing at all about a rebound hostname, which the browser
    // considers same-origin.
    const host = request.headers.host;
    if (!host || !allowedHosts.has(host.toLowerCase())) {
      return reply.code(403).send(apiError("forbidden_host", "This service only accepts loopback requests"));
    }
    const origin = request.headers.origin;
    if (origin && isAllowedOrigin(origin)) {
      reply
        .header("access-control-allow-origin", origin)
        .header("vary", "Origin")
        .header("access-control-allow-methods", "GET,POST,PUT,PATCH,OPTIONS")
        .header("access-control-allow-headers", "content-type,accept");
    } else if (origin && request.method !== "GET" && request.method !== "OPTIONS") {
      return reply.code(403).send(apiError("forbidden_origin", "This origin may not make state-changing requests"));
    }
    if (request.method === "OPTIONS") return reply.code(204).send();
  });

  // Without these, an exception escaping a handler falls through to Fastify's default
  // serializer, which puts `err.message` on the wire — a SQLite error surfaces as
  // `SQLITE_CONSTRAINT: <table>.<column>` to the caller — and in a shape that is not the
  // apiOk/apiError envelope every other response in this API uses.
  app.setErrorHandler((error: unknown, request, reply) => {
    request.log.error({ err: error }, "unhandled route error");
    const fastifyError = error as { statusCode?: unknown; message?: unknown };
    const raw = fastifyError.statusCode;
    // Only client-error statuses are trusted from the error object; anything else becomes a 500
    // so an internal fault can never masquerade as a successful or redirect response.
    const status = typeof raw === "number" && raw >= 400 && raw < 500 ? raw : 500;
    const code = status === 400 ? "invalid_request" : status === 413 ? "input_too_large" : "internal_error";
    // A handler that already began streaming (SSE) cannot be given a status line or a JSON body.
    if (reply.raw.headersSent) { reply.raw.end(); return; }
    const message = status >= 500
      ? "The server could not complete this request"
      : typeof fastifyError.message === "string" ? fastifyError.message : "Request rejected";
    return reply.code(status).send(apiError(code, message));
  });
  app.setNotFoundHandler((_request, reply) =>
    reply.code(404).send(apiError("route_not_found", "No such endpoint")),
  );

  await registerAuthPlugin(app);
  await app.register(oralAuthRoutes);
  await app.register(blueprintRoutes);
  await app.register(oralSessionRoutes);
  await app.register(oralSpeechRoutes);
  await app.register(reviewRoutes);

  // Envelope, like everything else. These routes carry no API_PREFIX, but that is the only respect
  // in which they are exceptions — a client that reads body.data / body.error.code should not need
  // a second code path for them.
  app.get("/health", async () => apiOk({ ok: true }));

  // Same-origin demo console for exercising the implemented API without a real FE — avoids
  // standing up CORS for a throwaway page.
  app.get("/demo", async (_req, reply) => {
    const demoPath = path.resolve(__dirname, "../public/demo.html");
    // Checked before streaming: handing reply.send() a stream that errors after the headers are
    // set produces a truncated, statusless response instead of a clean 404.
    if (!fs.existsSync(demoPath))
      return reply.code(404).send(apiError("demo_unavailable", "The demo console is not installed"));
    return reply.type("text/html").send(fs.createReadStream(demoPath));
  });

  return app;
}
