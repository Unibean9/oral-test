import { TEACHER_HEADER, apiError } from './contracts.js';
import { getTeacher, type TeacherRow } from '../db/teachers.js';
import { validate as isUuid } from 'uuid';

/**
 * Reads X-Teacher-Id and resolves it to a TeacherRow, or sends the failure reply itself and
 * returns null (callers use the existing `if (!x) return;` early-return style already used by
 * ensureSession in sessionArtifacts.ts).
 *
 * This is identification, not authentication: it only checks that the id names a row in
 * `teachers`, nothing more. Anyone who can reach this loopback-only backend can send any
 * teacher id. Never add hashing, expiry, or revocation here, and never describe this check as
 * a security boundary in docs or comments.
 */
export function requireTeacher(req: any, reply: any): TeacherRow | null {
  const raw = req.headers[TEACHER_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value || !value.trim()) {
    reply.code(401).send(apiError('teacher_required', `${TEACHER_HEADER} header is required`));
    return null;
  }
  if (!isUuid(value)) {
    reply.code(422).send(apiError('invalid_teacher_id', `${TEACHER_HEADER} must be a UUID`));
    return null;
  }
  const teacher = getTeacher(value);
  if (!teacher) {
    reply.code(404).send(apiError('teacher_not_found', 'Teacher was not found'));
    return null;
  }
  return teacher;
}
