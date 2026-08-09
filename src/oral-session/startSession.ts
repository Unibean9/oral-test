import { getBlueprint } from '../db/blueprints.js';
import { createOralSession, type AssessmentSessionRow } from '../db/oralSessions.js';
import { askNextQuestion } from './questionEngine.js';
import type { QuestionRow } from '../db/questions.js';

export class BlueprintNotFoundError extends Error {
  constructor(blueprintId: string) { super(`blueprint ${blueprintId} does not exist`); this.name = 'BlueprintNotFoundError'; }
}

/**
 * Starts a new oral-test session from a seeded blueprint (Phase 1 — no draft/authoring step
 * exists) and materializes its first question. No kiosk/device-handoff: this runs entirely
 * within the caller's own authenticated teacher session (Phase 2's ownershipGuard applies at the
 * route layer, not here).
 */
export async function startOralTestSession(params: {
  blueprintId: string; teacherId: string; studentCode: string;
}): Promise<{ session: AssessmentSessionRow; firstQuestion: QuestionRow | null }> {
  if (!getBlueprint(params.blueprintId)) throw new BlueprintNotFoundError(params.blueprintId);
  const session = createOralSession(params);
  const firstQuestion = await askNextQuestion(session.session_id);
  return { session, firstQuestion };
}
