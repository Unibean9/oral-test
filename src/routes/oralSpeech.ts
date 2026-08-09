import type { FastifyInstance, FastifyRequest } from 'fastify';
import { apiError } from '../contracts.js';
import { ownershipGuard } from '../auth/ownershipGuard.js';
import { resolveOralSessionOwner } from '../db/oralSessions.js';
import { getQuestion } from '../db/questions.js';
import { QuestionNotFoundError, QuestionNotInSessionError } from '../oral-session/submitTurn.js';
import { stripMarkdownForSpeech } from '../tts/textSanitize.js';
import { SseWriter } from '../tts/sseWriter.js';
import { ensureJob, attachSseSubscriber } from '../oral-session/questionSpeechJobs.js';
import { ORAL_TEST_PREFIX } from './oralSessions.js';

function sessionOwner(req: FastifyRequest): string | undefined {
  const { sessionId } = req.params as { sessionId: string };
  return resolveOralSessionOwner(sessionId);
}

/**
 * SSE audio for one already-generated question. Attaches to a shared, question-scoped synthesis
 * job (src/oral-session/questionSpeechJobs.ts) rather than starting an isolated synthesis of its
 * own — concurrent requests for the same question share one `/synthesize/stream` call, and a
 * request arriving after prefetch already completed replays the cached result immediately.
 */
export async function oralSpeechRoutes(app: FastifyInstance) {
  app.get<{ Params: { sessionId: string; questionId: string } }>(
    `${ORAL_TEST_PREFIX}/sessions/:sessionId/questions/:questionId/speech`,
    { preHandler: ownershipGuard(sessionOwner) },
    async (req, reply) => {
      const { sessionId, questionId } = req.params;
      const question = getQuestion(questionId);
      if (!question) return reply.code(404).send(apiError('question_not_found', new QuestionNotFoundError(questionId).message));
      if (question.session_id !== sessionId) {
        return reply.code(422).send(apiError('question_not_in_session', new QuestionNotInSessionError(questionId, sessionId).message));
      }

      const job = ensureJob(question.question_id, stripMarkdownForSpeech(question.question_text), 'foreground');
      const writer = new SseWriter(reply, sessionId, questionId);
      const subscriber = attachSseSubscriber(job, writer);
      reply.raw.on('close', subscriber.detach);
      try {
        await subscriber.finished;
      } catch (err) {
        // pumpSpeechJob already logs and tears itself down internally; this is a last-resort net.
        req.log.error({ err }, 'speech SSE subscriber failed unexpectedly');
      }
      return reply;
    },
  );
}
