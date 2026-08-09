import { getTrace, getSession } from '../db/sessions.js';
import { getRoom, listSessionsInRoom, listRooms } from '../db/rooms.js';
import { getTeacher } from '../db/teachers.js';

/**
 * Reads local SQLite only. `diagnosis` and `traceEntry` are Claude-derived summaries of what the
 * group said — not verbatim transcript text (`turns.text` is never included here) — but they DO
 * leave the machine once uploaded. That asymmetry is the whole privacy boundary: the verbatim
 * record stays local, a model-written summary of it does not. The facilitator is instructed to
 * preserve the group's own distinctive phrases in `trace_entry`, so this field can carry their
 * actual words; it is bounded there to short phrases with no speaker attribution for exactly
 * this reason. See docs/system-architecture.md, "The transcript privacy boundary, in two parts".
 */
export function buildTraceJson(sessionId: string) {
  return getTrace(sessionId).map((row) => ({
    turnIndex: row.turn_index,
    phase: row.phase,
    technique: row.technique,
    diagnosis: row.diagnosis,
    traceEntry: row.trace_entry,
    createdAt: row.created_at,
  }));
}

export function buildMetadataJson(roomId: string, sessionId: string) {
  const room = getRoom(roomId);
  const session = getSession(sessionId);
  if (!room || !session) throw new Error('metadata_source_missing');
  const teacher = getTeacher(session.created_by_teacher_id);

  return {
    roomId,
    roomName: room.name,
    teacherName: teacher?.name ?? null,
    sessionId,
    sessionName: session.name,
    status: session.status,
    finalPhase: session.current_phase,
    startedAt: session.created_at,
    completedAt: session.wrapped_at,
  };
}

// Rebuilt whole each time — small, and a full overwrite has no merge semantics to get wrong.
export function buildRoomIndex(roomId: string) {
  const sessions = listSessionsInRoom(roomId);
  return { roomId, sessions: sessions.map((s) => ({ sessionId: s.session_id, name: s.name, status: s.status })) };
}

export function buildTeacherIndex(teacherId: string) {
  const rooms = listRooms().filter((r) => r.owner_teacher_id === teacherId);
  return { teacherId, rooms: rooms.map((r) => ({ roomId: r.room_id, name: r.name })) };
}
