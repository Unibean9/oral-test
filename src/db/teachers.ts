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

// --- Password-based auth (oral-test domain, Phase 2) -----------------------------------------

const insertTeacherWithPassword = db.prepare(
  'INSERT INTO teachers (teacher_id, code, name, created_at, password_hash) VALUES (?, ?, ?, ?, ?)',
);
/**
 * Registers a brand-new teacher with a password. Never silently logs an existing code back in —
 * a taken code is a 409 at the route layer, not an implicit login, because that would let anyone
 * "claim" an existing identity by just picking its code and inventing a password.
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
