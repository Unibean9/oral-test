import type { FastifyInstance, FastifyRequest } from 'fastify';
import { apiOk, apiError } from '../contracts.js';
import { ownershipGuard } from '../auth/ownershipGuard.js';
import { RoomBusyError } from '../claude-cli/lock.js';
import { getOralSession, resolveOralSessionOwner, listOralSessionsForTeacher, endOralSession } from '../db/oralSessions.js';
import { listQuestionsForSession, getQuestion } from '../db/questions.js';
import { startOralTestSession, CourseHasNoBlueprintsError } from '../oral-session/startSession.js';
import { submitOralTurn, QuestionNotFoundError, QuestionNotInSessionError, SessionNotInProgressError } from '../oral-session/submitTurn.js';
import { UngroundableSlotError } from '../oral-session/questionEngine.js';

export const ORAL_TEST_PREFIX = '/api/v1/oral-test';
const INPUT_MODES = ['stt', 'typed'] as const;

function questionDto(q: ReturnType<typeof getQuestion> | null) {
  if (!q) return null;
  return {
    questionId: q.question_id, sessionId: q.session_id, slotId: q.slot_id, chapterId: q.chapter_id,
    cloId: q.clo_id, bloomLevel: q.bloom_level, sourceChunkIds: JSON.parse(q.source_chunk_ids) as string[],
    questionText: q.question_text, createdAt: q.created_at,
  };
}

function sessionOwner(req: FastifyRequest): string | undefined {
  const { sessionId } = req.params as { sessionId: string };
  return resolveOralSessionOwner(sessionId);
}

/** Maps the oral-session engine's typed errors to the right HTTP status — every other error
 * escapes to app.ts's setErrorHandler as a generic 500. */
function handleEngineError(err: unknown, reply: any): boolean {
  if (err instanceof CourseHasNoBlueprintsError) { reply.code(404).send(apiError('course_not_found', err.message)); return true; }
  if (err instanceof QuestionNotFoundError) { reply.code(404).send(apiError('question_not_found', err.message)); return true; }
  if (err instanceof QuestionNotInSessionError) { reply.code(422).send(apiError('question_not_in_session', err.message)); return true; }
  if (err instanceof SessionNotInProgressError) { reply.code(409).send(apiError('session_not_in_progress', err.message)); return true; }
  if (err instanceof UngroundableSlotError) { reply.code(502).send(apiError('ungroundable_slot', err.message)); return true; }
  if (err instanceof RoomBusyError) { reply.code(409).send(apiError('session_busy', err.message)); return true; }
  return false;
}

export async function oralSessionRoutes(app: FastifyInstance) {
  app.post<{ Body: { courseId?: string; studentCode?: string } }>(
    `${ORAL_TEST_PREFIX}/sessions`,
    { preHandler: app.authenticate },
    async (req, reply) => {
      const body = req.body ?? {};
      const courseId = typeof body.courseId === 'string' ? body.courseId.trim() : '';
      const studentCode = typeof body.studentCode === 'string' ? body.studentCode.trim() : '';
      if (!courseId) return reply.code(422).send(apiError('invalid_course_id', 'courseId is required'));
      if (!studentCode || studentCode.length > 64) return reply.code(422).send(apiError('invalid_student_code', 'studentCode is required'));
      try {
        const { session, firstQuestion } = await startOralTestSession({ courseId, teacherId: req.user.teacherId, studentCode });
        return reply.code(201).send(apiOk({
          sessionId: session.session_id, blueprintId: session.blueprint_id, status: session.status,
          startedAt: session.started_at, expiresAt: session.expires_at, question: questionDto(firstQuestion),
        }));
      } catch (err) {
        if (handleEngineError(err, reply)) return;
        throw err;
      }
    },
  );

  app.get(`${ORAL_TEST_PREFIX}/sessions`, { preHandler: app.authenticate }, async (req, reply) => {
    const sessions = listOralSessionsForTeacher(req.user.teacherId);
    return reply.send(apiOk(sessions.map((s) => ({
      sessionId: s.session_id, blueprintId: s.blueprint_id, studentCode: s.student_code,
      status: s.status, startedAt: s.started_at, endedAt: s.ended_at,
    }))));
  });

  app.get<{ Params: { sessionId: string } }>(
    `${ORAL_TEST_PREFIX}/sessions/:sessionId`,
    { preHandler: ownershipGuard(sessionOwner) },
    async (req, reply) => {
      const session = getOralSession(req.params.sessionId)!; // ownershipGuard already proved existence
      const questions = listQuestionsForSession(session.session_id);
      return reply.send(apiOk({
        sessionId: session.session_id, blueprintId: session.blueprint_id, studentCode: session.student_code,
        status: session.status, startedAt: session.started_at, endedAt: session.ended_at,
        questions: questions.map((q) => questionDto(q)),
      }));
    },
  );

  app.post<{ Params: { sessionId: string }; Body: { questionId?: string; inputMode?: string; text?: string } }>(
    `${ORAL_TEST_PREFIX}/sessions/:sessionId/turns`,
    { preHandler: ownershipGuard(sessionOwner) },
    async (req, reply) => {
      const body = req.body ?? {};
      const questionId = typeof body.questionId === 'string' ? body.questionId : '';
      const text = typeof body.text === 'string' ? body.text.trim() : '';
      const inputMode = body.inputMode;
      if (!questionId) return reply.code(422).send(apiError('invalid_question_id', 'questionId is required'));
      if (!inputMode || !INPUT_MODES.includes(inputMode as (typeof INPUT_MODES)[number])) {
        return reply.code(422).send(apiError('invalid_input_mode', 'inputMode must be "stt" or "typed"'));
      }
      if (!text) return reply.code(422).send(apiError('invalid_text', 'text is required'));
      try {
        const { turn, nextQuestion } = await submitOralTurn({
          sessionId: req.params.sessionId, questionId, inputMode: inputMode as 'stt' | 'typed', text,
        });
        return reply.code(201).send(apiOk({
          turnId: turn.turn_id, questionId: turn.question_id, createdAt: turn.created_at,
          nextQuestion: questionDto(nextQuestion), sessionCompleted: nextQuestion === null,
        }));
      } catch (err) {
        if (handleEngineError(err, reply)) return;
        throw err;
      }
    },
  );

  app.post<{ Params: { sessionId: string } }>(
    `${ORAL_TEST_PREFIX}/sessions/:sessionId/end`,
    { preHandler: ownershipGuard(sessionOwner) },
    async (req, reply) => {
      const ended = endOralSession(req.params.sessionId);
      if (!ended) return reply.code(409).send(apiError('session_not_in_progress', 'Session is not in_progress'));
      return reply.send(apiOk({ sessionId: req.params.sessionId, status: 'completed' }));
    },
  );
}
