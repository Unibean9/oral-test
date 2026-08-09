import { listBlueprintsByCourse } from '../db/blueprints.js';
import { createOralSession, endOralSession, type AssessmentSessionRow } from '../db/oralSessions.js';
import { askNextQuestion } from './questionEngine.js';
import type { QuestionRow } from '../db/questions.js';

export class CourseHasNoBlueprintsError extends Error {
  constructor(courseId: string) { super(`course ${courseId} has no blueprints`); this.name = 'CourseHasNoBlueprintsError'; }
}

/**
 * Starts a new oral-test session for a chosen course (subject). The teacher only picks the
 * course — the specific blueprint is picked at random from that course's seeded blueprints, so a
 * course with several blueprint variants rotates between them instead of always drawing the same
 * exam. Materializes the first question. No kiosk/device-handoff: this runs entirely within the
 * caller's own authenticated teacher session (ownershipGuard applies at the route layer, not
 * here).
 */
export async function startOralTestSession(params: {
  courseId: string; teacherId: string; studentCode: string;
}): Promise<{ session: AssessmentSessionRow; firstQuestion: QuestionRow | null }> {
  const blueprints = listBlueprintsByCourse(params.courseId);
  if (blueprints.length === 0) throw new CourseHasNoBlueprintsError(params.courseId);
  const blueprint = blueprints[Math.floor(Math.random() * blueprints.length)];
  const session = createOralSession({ blueprintId: blueprint.blueprint_id, teacherId: params.teacherId, studentCode: params.studentCode });
  try {
    const firstQuestion = await askNextQuestion(session.session_id);
    return { session, firstQuestion };
  } catch (err) {
    // The session row committed before the first examiner call; if that call fails, ending the
    // session here (instead of leaving it in_progress with zero questions) keeps a failed start
    // from producing a permanently unusable, permanently-listed session.
    endOralSession(session.session_id, { reason: 'ended_early' });
    throw err;
  }
}
