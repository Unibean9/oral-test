import type { FastifyInstance } from 'fastify';
import { apiOk, apiError, validateName } from '../contracts.js';
import { registerTeacherWithPassword, getTeacherByCode } from '../db/teachers.js';
import { hashPassword, verifyPassword } from '../auth/passwords.js';
import { issueTeacherCookie, clearTeacherCookie } from '../auth/jwt.js';

export const ORAL_AUTH_PREFIX = '/api/v1/oral-test/auth';

const MIN_PASSWORD_LENGTH = 8;
const MAX_CODE_LENGTH = 64;

function validateCode(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_CODE_LENGTH) return null;
  return trimmed;
}

function rejectUnknownKeys(body: unknown, allowed: string[]): boolean {
  return typeof body === 'object' && body !== null && Object.keys(body).every((key) => allowed.includes(key));
}

export async function oralAuthRoutes(app: FastifyInstance) {
  app.post<{ Body: { code?: string; name?: string; password?: string } }>(`${ORAL_AUTH_PREFIX}/register`, async (req, reply) => {
    const body = req.body ?? {};
    if (!rejectUnknownKeys(body, ['code', 'name', 'password'])) return reply.code(422).send(apiError('invalid_request', 'Unknown field in request body'));
    const code = validateCode(body.code);
    const name = validateName(body.name);
    const password = typeof body.password === 'string' ? body.password : '';
    if (!code) return reply.code(422).send(apiError('invalid_code', 'code is required'));
    if (!name) return reply.code(422).send(apiError('invalid_name', 'name is required'));
    if (password.length < MIN_PASSWORD_LENGTH) return reply.code(422).send(apiError('invalid_password', `password must be at least ${MIN_PASSWORD_LENGTH} characters`));
    // A taken code (legacy password-less row, or already-registered) is a conflict, never an
    // implicit login — see db/teachers.ts's registerTeacherWithPassword doc comment.
    if (getTeacherByCode(code)) return reply.code(409).send(apiError('code_taken', 'This code is already registered'));
    const teacher = registerTeacherWithPassword(code, name, hashPassword(password));
    issueTeacherCookie(reply, teacher.teacher_id);
    return reply.code(201).send(apiOk({ teacherId: teacher.teacher_id, code: teacher.code, name: teacher.name }));
  });

  app.post<{ Body: { code?: string; password?: string } }>(`${ORAL_AUTH_PREFIX}/login`, async (req, reply) => {
    const body = req.body ?? {};
    if (!rejectUnknownKeys(body, ['code', 'password'])) return reply.code(422).send(apiError('invalid_request', 'Unknown field in request body'));
    const code = validateCode(body.code);
    const password = typeof body.password === 'string' ? body.password : '';
    if (!code || !password) return reply.code(422).send(apiError('invalid_request', 'code and password are required'));
    const teacher = getTeacherByCode(code);
    // Same generic failure whether the code is unknown or the row has no password (legacy) or
    // the password is wrong — never let a caller distinguish "no such code" from "wrong password".
    if (!teacher || !teacher.password_hash || !verifyPassword(password, teacher.password_hash)) {
      return reply.code(401).send(apiError('invalid_credentials', 'Invalid code or password'));
    }
    issueTeacherCookie(reply, teacher.teacher_id);
    return reply.send(apiOk({ teacherId: teacher.teacher_id, code: teacher.code, name: teacher.name }));
  });

  app.post(`${ORAL_AUTH_PREFIX}/logout`, async (_req, reply) => {
    clearTeacherCookie(reply);
    return reply.send(apiOk({ ok: true }));
  });

  app.get(`${ORAL_AUTH_PREFIX}/me`, { preHandler: app.authenticate }, async (req, reply) =>
    reply.send(apiOk({ teacherId: req.user.teacherId })));
}
