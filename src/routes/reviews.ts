import type { FastifyInstance, FastifyRequest } from 'fastify';
import { apiOk, apiError } from '../contracts.js';
import { ownershipGuard } from '../auth/ownershipGuard.js';
import { RoomBusyError } from '../claude-cli/lock.js';
import { getOralSession, resolveOralSessionOwner, setOralSessionStatus } from '../db/oralSessions.js';
import { listQuestionsForSession, listTurnsForQuestion, getQuestion } from '../db/questions.js';
import { RUBRIC_LEVELS, listRubricItemsForSession, getRubricItem, overrideRubricItem, approveRubricItemsForSession, type RubricLevel } from '../db/rubric.js';
import { getReportForSession, approveReport } from '../db/reports.js';
import { draftReview, SessionNotCompletedError, ReportAlreadyExistsError } from '../review/draftReview.js';
import { renderReportHtml, ReportNotApprovedError } from '../report/renderReport.js';

export const ORAL_TEST_PREFIX = '/api/v1/oral-test';

function sessionOwner(req: FastifyRequest): string | undefined {
  const { sessionId } = req.params as { sessionId: string };
  return resolveOralSessionOwner(sessionId);
}

function rubricItemDto(item: ReturnType<typeof getRubricItem>) {
  if (!item) return null;
  return {
    itemId: item.item_id, questionId: item.question_id, aiSuggestedLevel: item.ai_suggested_level,
    lecturerOverrideLevel: item.lecturer_override_level, evidenceTurnIds: JSON.parse(item.evidence_turn_ids) as string[],
    comment: item.comment, approver: item.approver, approvedAt: item.approved_at,
  };
}

function handleReviewError(err: unknown, reply: any): boolean {
  if (err instanceof SessionNotCompletedError) { reply.code(409).send(apiError('session_not_completed', err.message)); return true; }
  if (err instanceof ReportAlreadyExistsError) { reply.code(409).send(apiError('report_already_exists', err.message)); return true; }
  if (err instanceof ReportNotApprovedError) { reply.code(409).send(apiError('report_not_approved', err.message)); return true; }
  if (err instanceof RoomBusyError) { reply.code(409).send(apiError('session_busy', err.message)); return true; }
  return false;
}

export async function reviewRoutes(app: FastifyInstance) {
  app.post<{ Params: { sessionId: string } }>(
    `${ORAL_TEST_PREFIX}/sessions/:sessionId/review`,
    { preHandler: ownershipGuard(sessionOwner) },
    async (req, reply) => {
      try {
        const { report, items } = await draftReview(req.params.sessionId);
        return reply.code(201).send(apiOk({
          reportId: report.report_id, sessionId: report.session_id, status: report.status,
          items: items.map((item) => rubricItemDto(item)),
        }));
      } catch (err) {
        if (handleReviewError(err, reply)) return;
        throw err;
      }
    },
  );

  app.get<{ Params: { sessionId: string } }>(
    `${ORAL_TEST_PREFIX}/sessions/:sessionId/report`,
    { preHandler: ownershipGuard(sessionOwner) },
    async (req, reply) => {
      const report = getReportForSession(req.params.sessionId);
      if (!report) return reply.code(404).send(apiError('report_not_found', 'No report has been drafted for this session yet'));
      const items = listRubricItemsForSession(req.params.sessionId);
      return reply.send(apiOk({
        reportId: report.report_id, sessionId: report.session_id, status: report.status,
        approvedBy: report.approved_by, approvedAt: report.approved_at,
        items: items.map((item) => rubricItemDto(item)),
      }));
    },
  );

  app.put<{ Params: { sessionId: string; itemId: string }; Body: { lecturerOverrideLevel?: string | null; comment?: string | null } }>(
    `${ORAL_TEST_PREFIX}/sessions/:sessionId/rubric-items/:itemId`,
    { preHandler: ownershipGuard(sessionOwner) },
    async (req, reply) => {
      const item = getRubricItem(req.params.itemId);
      if (!item) return reply.code(404).send(apiError('rubric_item_not_found', 'Rubric item was not found'));
      const question = getQuestion(item.question_id);
      if (!question || question.session_id !== req.params.sessionId) {
        return reply.code(404).send(apiError('rubric_item_not_found', 'Rubric item does not belong to this session'));
      }
      const body = req.body ?? {};
      const level = body.lecturerOverrideLevel;
      if (level !== undefined && level !== null && !RUBRIC_LEVELS.includes(level as RubricLevel)) {
        return reply.code(422).send(apiError('invalid_rubric_level', `lecturerOverrideLevel must be one of ${RUBRIC_LEVELS.join(', ')}`));
      }
      const comment = typeof body.comment === 'string' ? body.comment.trim() : null;
      overrideRubricItem(req.params.itemId, { lecturerOverrideLevel: (level as RubricLevel | null | undefined) ?? null, comment });
      return reply.send(apiOk(rubricItemDto(getRubricItem(req.params.itemId))));
    },
  );

  app.patch<{ Params: { sessionId: string } }>(
    `${ORAL_TEST_PREFIX}/sessions/:sessionId/report/approve`,
    { preHandler: ownershipGuard(sessionOwner) },
    async (req, reply) => {
      const report = getReportForSession(req.params.sessionId);
      if (!report) return reply.code(404).send(apiError('report_not_found', 'No report has been drafted for this session yet'));
      const approved = approveReport(req.params.sessionId, req.user.teacherId);
      if (!approved) return reply.code(409).send(apiError('report_already_approved', 'Report is not in draft status'));
      approveRubricItemsForSession(req.params.sessionId, req.user.teacherId);
      setOralSessionStatus(req.params.sessionId, 'approved');
      return reply.send(apiOk({ sessionId: req.params.sessionId, reportId: report.report_id, status: 'approved' }));
    },
  );

  app.get<{ Params: { sessionId: string } }>(
    `${ORAL_TEST_PREFIX}/sessions/:sessionId/report/html`,
    { preHandler: ownershipGuard(sessionOwner) },
    async (req, reply) => {
      const session = getOralSession(req.params.sessionId)!;
      const report = getReportForSession(req.params.sessionId);
      if (!report) return reply.code(404).send(apiError('report_not_found', 'No report has been drafted for this session yet'));
      try {
        const items = listRubricItemsForSession(req.params.sessionId);
        const questions = listQuestionsForSession(req.params.sessionId);
        const turnsByQuestionId = new Map(questions.map((q) => [q.question_id, listTurnsForQuestion(q.question_id)]));
        const html = renderReportHtml({ session, report, items, questions, turnsByQuestionId });
        return reply.type('text/html').send(html);
      } catch (err) {
        if (handleReviewError(err, reply)) return;
        throw err;
      }
    },
  );
}
