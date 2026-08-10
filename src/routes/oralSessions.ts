import type { FastifyInstance, FastifyRequest } from 'fastify';
import { apiOk, apiError, LIMITS, validateBoundedText } from '../contracts.js';
import { ownershipGuard } from '../auth/ownershipGuard.js';
import { getOralSession, resolveOralSessionOwner, listOralSessionsForTeacher, endOralSession } from '../db/oralSessions.js';
import { listQuestionsForSession, getQuestion } from '../db/questions.js';
import { startOralTestSession } from '../oral-session/startSession.js';
import { startOralTurn } from '../oral-session/submitTurn.js';
import { mapEngineError } from '../oral-session/engineErrors.js';

export const ORAL_TEST_PREFIX = '/api/v1/oral-test';
const INPUT_MODES = ['stt', 'typed'] as const;

export function questionDto(q: ReturnType<typeof getQuestion> | null) {
  if (!q) return null;
  return {
    questionId: q.question_id, sessionId: q.session_id, slotId: q.slot_id, chapterId: q.chapter_id,
    cloId: q.clo_id, bloomLevel: q.bloom_level, sourceChunkIds: JSON.parse(q.source_chunk_ids) as string[],
    questionText: q.question_text, createdAt: q.created_at,
    action: q.action, parentQuestionId: q.parent_question_id,
  };
}

function sessionOwner(req: FastifyRequest): string | undefined {
  const { sessionId } = req.params as { sessionId: string };
  return resolveOralSessionOwner(sessionId);
}

/** Maps the oral-session engine's typed errors to the right HTTP status — every other error
 * escapes to app.ts's setErrorHandler as a generic 500. */
function handleEngineError(err: unknown, reply: any): boolean {
  const mapped = mapEngineError(err);
  if (!mapped) return false;
  reply.code(mapped.status).send(apiError(mapped.code, (err as Error).message, mapped.recoverable));
  return true;
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
      const inputMode = body.inputMode;
      if (!questionId) return reply.code(422).send(apiError('invalid_question_id', 'questionId is required'));
      if (!inputMode || !INPUT_MODES.includes(inputMode as (typeof INPUT_MODES)[number])) {
        return reply.code(422).send(apiError('invalid_input_mode', 'inputMode must be "stt" or "typed"'));
      }
      // Bounded/normalized before the request fingerprint is computed or any DB/CLI work starts —
      // an oversized or control-character-bearing answer is rejected outright, never truncated.
      const text = validateBoundedText(body.text, LIMITS.studentAnswerBytes);
      if (!text) return reply.code(422).send(apiError('invalid_text', `text is required and must be a non-empty string up to ${LIMITS.studentAnswerBytes} bytes with no control characters`));
      try {
        const started = await startOralTurn({
          sessionId: req.params.sessionId, questionId, inputMode: inputMode as 'stt' | 'typed', text,
        });
        if (started.kind === 'immediate') {
          // Already resolved without touching the CLI (idempotent replay) — same shape and status
          // as the old fully-synchronous response, so a client that never adopts the stream still
          // works for retries.
          return reply.code(201).send(apiOk({
            turnId: started.turn.turn_id, questionId: started.turn.question_id, createdAt: started.turn.created_at,
            nextQuestion: questionDto(started.nextQuestion), sessionCompleted: started.nextQuestion === null,
            completionReason: started.completionReason, streamUrl: null,
          }));
        }
        // The examiner's next-move CLI call is running in the background — the turn itself is
        // already durably committed, so this returns immediately instead of the client sitting on
        // one silent await for the full 10-15s CLI round trip. `streamUrl` is the SSE endpoint that
        // reports its progress and terminal result.
        return reply.code(202).send(apiOk({
          turnId: started.turn.turn_id, questionId: started.turn.question_id, createdAt: started.turn.created_at,
          nextQuestion: null, sessionCompleted: null, completionReason: null,
          streamUrl: `${ORAL_TEST_PREFIX}/sessions/${req.params.sessionId}/turns/${started.turn.turn_id}/stream`,
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
