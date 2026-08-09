import type { FastifyInstance } from 'fastify';
import { apiOk, apiError } from '../contracts.js';
import { listBlueprints, getBlueprint, listSlotsForBlueprint } from '../db/blueprints.js';

export const ORAL_TEST_PREFIX = '/api/v1/oral-test';

// Read-only, unauthenticated: blueprints are static seed data shared across every teacher in
// this MVP (see plan.md — no draft/approve/authoring workflow exists). No mutation route exists
// in this file by design.
export async function blueprintRoutes(app: FastifyInstance) {
  app.get(`${ORAL_TEST_PREFIX}/blueprints`, async (_req, reply) => {
    const blueprints = listBlueprints();
    return reply.send(apiOk(blueprints.map((b) => ({ blueprintId: b.blueprint_id, courseId: b.course_id, name: b.name, createdAt: b.created_at }))));
  });

  app.get<{ Params: { blueprintId: string } }>(`${ORAL_TEST_PREFIX}/blueprints/:blueprintId/slots`, async (req, reply) => {
    const { blueprintId } = req.params;
    if (!getBlueprint(blueprintId)) return reply.code(404).send(apiError('blueprint_not_found', 'Blueprint was not found'));
    const slots = listSlotsForBlueprint(blueprintId);
    return reply.send(apiOk(slots.map((s) => ({
      slotId: s.slot_id, chapterId: s.chapter_id, cloId: s.clo_id, bloomLevel: s.bloom_level,
      questionCount: s.question_count, difficultyHint: s.difficulty_hint,
    }))));
  });
}
