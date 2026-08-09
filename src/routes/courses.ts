import type { FastifyInstance } from 'fastify';
import { apiOk } from '../contracts.js';
import { listCourses } from '../db/courses.js';

export const ORAL_TEST_PREFIX = '/api/v1/oral-test';

// Read-only, unauthenticated: courses are static seed data, same justification as blueprints.ts.
// This is the list a teacher picks a subject from — session creation then randomly draws one
// blueprint from that course (see startSession.ts).
export async function courseRoutes(app: FastifyInstance) {
  app.get(`${ORAL_TEST_PREFIX}/courses`, async (_req, reply) => {
    const courses = listCourses();
    return reply.send(apiOk(courses.map((c) => ({ courseId: c.course_id, name: c.name, createdAt: c.created_at }))));
  });
}
