import type { FastifyInstance } from 'fastify';
import { v4 as uuidv4 } from 'uuid';
import { API_PREFIX, apiOk, apiError, isRoomId, validateName, SUPPORTED_VOICES, DEFAULT_VOICE_ID, isVoiceId, validateVoiceId } from '../brainstorm/contracts.js';
import { requireTeacher } from '../brainstorm/teacherContext.js';
import { loginOrRegisterTeacher, listTeachers } from '../db/teachers.js';
import { createRoom, getRoom, listRooms, listSessionsInRoom } from '../db/rooms.js';
import { createSession, getSession, getPublicTranscript, getActiveOperation, getLatestInterruptedOperation, getLatestFailedOperation } from '../db/sessions.js';
import * as claude from '../claude-cli/spawn.js';

function sessionSnapshot(sessionId: string) {
  const session = getSession(sessionId);
  if (!session) return null;
  // `failed` is folded in after `interrupted` so a client reloading after a failed turn sees the
  // same operation POST /turns is answering 409 turn_failed about. `state` stays 'idle' for both:
  // neither is running, and only `processing`/`accepted` mean work is in flight.
  const active =
    getActiveOperation(sessionId) ?? getLatestInterruptedOperation(sessionId) ?? getLatestFailedOperation(sessionId);
  return {
    sessionId,
    voiceId: isVoiceId(session.voice_id) ? session.voice_id : DEFAULT_VOICE_ID,
    engineStep: session.engine_step,
    phaseKey: session.current_phase,
    state: active?.status === 'processing' || active?.status === 'accepted' ? 'processing' : 'idle',
    transcript: getPublicTranscript(sessionId),
    activeTurn: active && {
      turnId: active.turn_id,
      clientTurnId: active.client_turn_id,
      status: active.status,
      userMessageId: active.user_message_id,
      assistantMessageId: active.assistant_message_id,
      lastSeq: active.final_seq,
    },
  };
}

function rejectUnknownKeys(body: unknown, allowed: string[]): boolean {
  return typeof body === 'object' && body !== null && Object.keys(body).every((key) => allowed.includes(key));
}

export async function teacherRoomRoutes(app: FastifyInstance) {
  app.post<{ Body: { code?: string; name?: string } }>(`${API_PREFIX}/teachers`, async (req, reply) => {
    const body = req.body ?? {};
    if (!rejectUnknownKeys(body, ['code', 'name'])) return reply.code(422).send(apiError('invalid_teacher', 'Unknown field in request body'));
    const code = typeof body.code === 'string' ? body.code.trim() : '';
    const name = validateName(body.name);
    if (!code || code.length > 64) return reply.code(422).send(apiError('invalid_code', 'code is required'));
    if (!name) return reply.code(422).send(apiError('invalid_name', 'name is required'));
    // Login-or-register: a known code returns that teacher (200), an unknown one creates (201).
    // `isNew` lets the UI say "logged in as <registered name>" instead of claiming a new signup.
    const { created, teacher } = loginOrRegisterTeacher(code, name);
    return reply.code(created ? 201 : 200).send(apiOk({ teacherId: teacher.teacher_id, code: teacher.code, name: teacher.name, createdAt: teacher.created_at, isNew: created }));
  });

  // teacherId is omitted here simply because no client needs it from this endpoint — GET /rooms
  // already returns ownerTeacherId/ownerName directly. It is NOT a protection: that same
  // GET /rooms hands out every owner's teacher id unauthenticated, and per this project's
  // constraints X-Teacher-Id is attribution only, never a trust boundary. Do not reintroduce
  // language here suggesting that withholding the id secures anything.
  app.get(`${API_PREFIX}/teachers`, async (_req, reply) => {
    const teachers = listTeachers();
    return reply.send(apiOk(teachers.map((t) => ({ code: t.code, name: t.name, createdAt: t.created_at }))));
  });

  app.post<{ Body: { name?: string } }>(`${API_PREFIX}/rooms`, async (req, reply) => {
    const teacher = requireTeacher(req, reply);
    if (!teacher) return;
    const body = req.body ?? {};
    if (!rejectUnknownKeys(body, ['name'])) return reply.code(422).send(apiError('invalid_room', 'Unknown field in request body'));
    const name = validateName(body.name);
    if (!name) return reply.code(422).send(apiError('invalid_name', 'name is required'));
    const room = createRoom({ name, ownerTeacherId: teacher.teacher_id });
    return reply.code(201).send(apiOk({ roomId: room.room_id, name: room.name, ownerTeacherId: room.owner_teacher_id, createdAt: room.created_at }));
  });

  app.get(`${API_PREFIX}/rooms`, async (_req, reply) => {
    const rooms = listRooms();
    return reply.send(apiOk(rooms.map((r) => ({ roomId: r.room_id, name: r.name, ownerTeacherId: r.owner_teacher_id, ownerName: r.owner_name, createdAt: r.created_at }))));
  });

  // Unauthenticated, matching GET /teachers and GET /rooms — this is a static read-only list,
  // not per-teacher data.
  app.get(`${API_PREFIX}/voices`, async (_req, reply) =>
    reply.send(apiOk(SUPPORTED_VOICES.map((v) => ({ voiceId: v.id, label: v.label })))));

  app.post<{ Params: { roomId: string }; Body: { name?: string; voiceId?: string } }>(`${API_PREFIX}/rooms/:roomId/sessions`, async (req, reply) => {
    const teacher = requireTeacher(req, reply);
    if (!teacher) return;
    const { roomId } = req.params;
    if (!isRoomId(roomId)) return reply.code(422).send(apiError('invalid_room_id', 'roomId must be an rm_-prefixed id'));
    const room = getRoom(roomId);
    if (!room) return reply.code(404).send(apiError('room_not_found', 'Room was not found'));
    const body = req.body ?? {};
    if (!rejectUnknownKeys(body, ['name', 'voiceId'])) return reply.code(422).send(apiError('invalid_session', 'Unknown field in request body'));
    const name = validateName(body.name);
    if (!name) return reply.code(422).send(apiError('invalid_name', 'name is required'));
    const voiceId = validateVoiceId(body.voiceId);
    if (!voiceId) return reply.code(422).send(apiError('invalid_voice_id', 'voiceId must be one of the supported voices'));
    const sessionId = uuidv4();
    // Start the facilitator BEFORE committing the row. The old order wrote the session row
    // first and returned 502 without rolling it back, leaving a row whose on-disk `--session-id`
    // was never created: it stayed listed by GET /rooms/:roomId/sessions and accepted turns,
    // every one of which failed `--resume` with a generic turn_failed. The reverse order can at
    // worst leave a CLI session on disk that nothing references, which is inert.
    try {
      await claude.startRoomSession(sessionId);
    } catch (err) {
      req.log.error({ err }, 'facilitator session failed to start');
      return reply.code(502).send(apiError('facilitator_start_failed', 'Could not start the facilitator session'));
    }
    createSession({ sessionId, roomId, name, createdByTeacherId: teacher.teacher_id, voiceId });
    return reply.code(201).send(apiOk({ ...sessionSnapshot(sessionId), roomId, name }));
  });

  app.get<{ Params: { roomId: string } }>(`${API_PREFIX}/rooms/:roomId/sessions`, async (req, reply) => {
    const { roomId } = req.params;
    if (!isRoomId(roomId)) return reply.code(422).send(apiError('invalid_room_id', 'roomId must be an rm_-prefixed id'));
    if (!getRoom(roomId)) return reply.code(404).send(apiError('room_not_found', 'Room was not found'));
    const sessions = listSessionsInRoom(roomId);
    return reply.send(apiOk(sessions.map((s) => ({ sessionId: s.session_id, name: s.name, status: s.status, phaseKey: s.current_phase, createdAt: s.created_at }))));
  });
}
