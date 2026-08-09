import { v4 as uuidv4 } from 'uuid';
import { db } from './connection.js';

export interface TeacherRow {
  teacher_id: string;
  code: string;
  name: string;
  created_at: string;
  password_hash: string | null;
}

const selectByCode = db.prepare('SELECT * FROM teachers WHERE code = ?');
const insertTeacher = db.prepare('INSERT INTO teachers (teacher_id, code, name, created_at) VALUES (?, ?, ?, ?)');

/**
 * `code` IS the teacher's identity — one teacher, one permanent code — so a known code logs that
 * teacher back in and returns their existing row; only an unknown code creates one. Withholding
 * the row on a duplicate code would buy nothing: `GET /rooms` already publishes every owner's
 * `ownerTeacherId` unauthenticated, and `X-Teacher-Id` is attribution, never a trust boundary.
 *
 * A login never rewrites `name`: the stored name is what other teachers already see on rooms and
 * sessions, so the caller gets the registered row back and the UI shows that name.
 */
export const loginOrRegisterTeacher = db.transaction((code: string, name: string): { created: boolean; teacher: TeacherRow } => {
  const existing = selectByCode.get(code) as TeacherRow | undefined;
  if (existing) return { created: false, teacher: existing };
  const teacherId = uuidv4();
  const now = new Date().toISOString();
  insertTeacher.run(teacherId, code, name, now);
  return { created: true, teacher: { teacher_id: teacherId, code, name, created_at: now, password_hash: null } };
});

const selectById = db.prepare('SELECT * FROM teachers WHERE teacher_id = ?');
export function getTeacher(teacherId: string): TeacherRow | undefined {
  return selectById.get(teacherId) as TeacherRow | undefined;
}

// Excludes the bootstrap/system teacher row created by db/migrate.ts's migrationV2 — it is not a
// real teacher and must never appear in a teacher-facing listing.
const selectAllExceptLegacy = db.prepare("SELECT * FROM teachers WHERE code != '__legacy__' ORDER BY created_at ASC");
export function listTeachers(): TeacherRow[] {
  return selectAllExceptLegacy.all() as TeacherRow[];
}

// --- Password-based auth (oral-test domain, Phase 2) -----------------------------------------
// Separate from loginOrRegisterTeacher above, which is the legacy brainstorm identification-only
// flow (no secret, no auth). A row created by that flow has password_hash = NULL and cannot log
// in via registerTeacherWithPassword/verifyTeacherCredentials until a password is explicitly set.

const insertTeacherWithPassword = db.prepare(
  'INSERT INTO teachers (teacher_id, code, name, created_at, password_hash) VALUES (?, ?, ?, ?, ?)',
);
/**
 * Registers a brand-new teacher with a password. Unlike `loginOrRegisterTeacher`, this never
 * silently logs an existing code back in — a taken code (whether password-less legacy or
 * already-registered) is a 409 at the route layer, not an implicit login, because that would let
 * anyone "claim" an existing legacy identity by just picking its code and inventing a password.
 */
export function registerTeacherWithPassword(code: string, name: string, passwordHash: string): TeacherRow {
  const teacherId = uuidv4();
  const now = new Date().toISOString();
  insertTeacherWithPassword.run(teacherId, code, name, now, passwordHash);
  return { teacher_id: teacherId, code, name, created_at: now, password_hash: passwordHash };
}

/** Looks up a teacher by code for the password-login path. Does not verify the password itself
 * (that is auth/passwords.ts's job) — callers must still check `password_hash !== null`. */
export function getTeacherByCode(code: string): TeacherRow | undefined {
  return selectByCode.get(code) as TeacherRow | undefined;
}
