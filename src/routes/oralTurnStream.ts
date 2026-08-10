import type { FastifyInstance, FastifyRequest } from 'fastify';
import { apiError } from '../contracts.js';
import { ownershipGuard } from '../auth/ownershipGuard.js';
import { resolveOralSessionOwner, getOralSession } from '../db/oralSessions.js';
import { getOralTurnWithSession, getQuestion } from '../db/questions.js';
import { getTurnSubmission } from '../db/turnSubmissions.js';
import { getTurnJob } from '../oral-session/turnJobs.js';
import { SseWriter } from '../tts/sseWriter.js';
import { ORAL_TEST_PREFIX, questionDto } from './oralSessions.js';

function sessionOwner(req: FastifyRequest): string | undefined {
  const { sessionId } = req.params as { sessionId: string };
  return resolveOralSessionOwner(sessionId);
}

// How often 'examiner-thinking' fires while the background CLI call is still running — just
// frequent enough for a UI to animate progress, far below anything that would stress the socket.
// Test-overridable so a heartbeat-observing test doesn't have to sleep past the production interval.
const DEFAULT_HEARTBEAT_MS = 1_500;
let heartbeatMs = DEFAULT_HEARTBEAT_MS;
export function _setHeartbeatMsForTests(ms: number | null): void { heartbeatMs = ms ?? DEFAULT_HEARTBEAT_MS; }

/**
 * SSE progress/result for one turn's background examiner call (see submitTurn.ts's startOralTurn).
 * A turn that resolved immediately (idempotent replay) never gets a tracked job — this route only
 * serves the async 'pending' case POST /turns hands back a streamUrl for.
 */
export async function oralTurnStreamRoutes(app: FastifyInstance) {
  app.get<{ Params: { sessionId: string; turnId: string } }>(
    `${ORAL_TEST_PREFIX}/sessions/:sessionId/turns/:turnId/stream`,
    { preHandler: ownershipGuard(sessionOwner) },
    async (req, reply) => {
      const { sessionId, turnId } = req.params;
      const turn = getOralTurnWithSession(turnId);
      if (!turn || turn.session_id !== sessionId) {
        return reply.code(404).send(apiError('turn_not_found', `turn ${turnId} does not exist in session ${sessionId}`));
      }
      const job = getTurnJob(turnId);
      if (!job) {
        // The job is gone (retention window expired, or this process restarted since the CLI call
        // ran) but the outcome may still be durably recorded — a client that reconnects late (tab
        // backgrounded, brief network drop) should still get its answer instead of an opaque 404
        // for a turn that actually resolved successfully.
        const submission = getTurnSubmission(sessionId, turn.question_id);
        if (!submission) {
          return reply.code(404).send(apiError(
            'turn_job_not_found',
            `no examiner job is tracked for turn ${turnId}, and no durable result exists yet either`,
          ));
        }
        const nextQuestion = submission.next_question_id ? getQuestion(submission.next_question_id) ?? null : null;
        const completionReason = nextQuestion === null ? getOralSession(sessionId)?.completion_reason ?? null : null;
        const writer = new SseWriter(reply, sessionId, turnId);
        await writer.event('turn-resolved', {
          nextQuestion: questionDto(nextQuestion), sessionCompleted: nextQuestion === null, completionReason,
        });
        writer.done();
        return reply;
      }

      const writer = new SseWriter(reply, sessionId, turnId);

      const sendFinal = async (): Promise<void> => {
        if (job.state === 'done') {
          const { nextQuestion, completionReason } = job.result!;
          await writer.event('turn-resolved', {
            nextQuestion: questionDto(nextQuestion), sessionCompleted: nextQuestion === null, completionReason,
          });
        } else if (job.state === 'failed') {
          await writer.error(job.failure!.code, job.failure!.recoverable);
        }
        writer.done();
      };

      if (job.state !== 'running') {
        await sendFinal();
        return reply;
      }

      const heartbeat = setInterval(() => {
        void writer.event('examiner-thinking', {}).catch(() => {});
      }, heartbeatMs);
      reply.raw.on('close', () => clearInterval(heartbeat));
      try {
        await job.settled;
      } finally {
        clearInterval(heartbeat);
      }
      await sendFinal();
      return reply;
    },
  );
}
