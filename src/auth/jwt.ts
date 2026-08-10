import fastifyCookie from '@fastify/cookie';
import fastifyJwt from '@fastify/jwt';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { apiError } from '../contracts.js';

export const AUTH_COOKIE_NAME = 'oral_test_token';
// Short-lived per plan.md: no kiosk/capability-token mode exists in this domain, so the only way
// to keep working past this window is staying active (a real request re-signs, see login route)
// or logging back in — never a longer-lived secondary token.
export const TOKEN_TTL_SECONDS = 2 * 60 * 60;

// Loopback-only pilot tool (see app.ts's HOST comment) with a handful of teacher accounts — a
// fixed dev-fallback secret is accepted here so `npm test`/`npm run dev` work with zero setup,
// but a real deployment must set this explicitly. `NODE_ENV=production` fails closed instead of
// silently signing tokens with a secret every reader of this file already knows.
const MIN_JWT_SECRET_BYTES = 32; // 256 bits — HMAC-SHA256's own key-strength floor.
const DEV_FALLBACK_JWT_SECRET = 'dev-only-oral-test-secret-do-not-use-in-production';
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

function resolveJwtSecret(): string {
  const configured = process.env.ORAL_TEST_JWT_SECRET;
  if (!configured) {
    if (IS_PRODUCTION) throw new Error('[auth] ORAL_TEST_JWT_SECRET is required when NODE_ENV=production; refusing to start with the dev fallback secret.');
    console.warn('[auth] ORAL_TEST_JWT_SECRET not set; using an insecure dev-only fallback. Set it before any non-local deployment.');
    return DEV_FALLBACK_JWT_SECRET;
  }
  if (Buffer.byteLength(configured, 'utf8') < MIN_JWT_SECRET_BYTES) {
    if (IS_PRODUCTION) throw new Error(`[auth] ORAL_TEST_JWT_SECRET must be at least ${MIN_JWT_SECRET_BYTES} bytes when NODE_ENV=production.`);
    console.warn(`[auth] ORAL_TEST_JWT_SECRET is shorter than the recommended ${MIN_JWT_SECRET_BYTES} bytes; acceptable only outside production.`);
  }
  return configured;
}

const JWT_SECRET = resolveJwtSecret();

export interface TeacherJwtPayload {
  teacherId: string;
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: TeacherJwtPayload;
    user: TeacherJwtPayload;
  }
}

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

export async function registerAuthPlugin(app: FastifyInstance): Promise<void> {
  await app.register(fastifyCookie);
  await app.register(fastifyJwt, {
    secret: JWT_SECRET,
    sign: { expiresIn: TOKEN_TTL_SECONDS },
    cookie: { cookieName: AUTH_COOKIE_NAME, signed: false },
  });

  // Single source of "is this request authenticated" for every oral-test route — a route wires
  // this as a preHandler, or ownershipGuard.ts's factory does it internally.
  app.decorate('authenticate', async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      await req.jwtVerify();
    } catch {
      reply.code(401).send(apiError('unauthenticated', 'A valid teacher session is required'));
    }
  });
}

export function issueTeacherCookie(reply: FastifyReply, teacherId: string): void {
  const token = reply.server.jwt.sign({ teacherId });
  reply.setCookie(AUTH_COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/',
    maxAge: TOKEN_TTL_SECONDS,
  });
}

export function clearTeacherCookie(reply: FastifyReply): void {
  reply.clearCookie(AUTH_COOKIE_NAME, { path: '/' });
}
