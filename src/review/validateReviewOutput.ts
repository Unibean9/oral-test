import { listQuestionsForSession, listTurnsForQuestion } from '../db/questions.js';
import { RUBRIC_LEVELS, type RubricLevel } from '../db/rubric.js';

export const REVIEW_OUTPUT_OPEN = '<oral-review-output>';
export const REVIEW_OUTPUT_CLOSE = '</oral-review-output>';

export interface ReviewItem {
  question_id: string;
  ai_suggested_level: RubricLevel;
  evidence_turn_ids: string[];
  rationale: string;
}
export interface ReviewOutput {
  items: ReviewItem[];
}

export class ReviewOutputParseError extends Error {
  constructor(reason: string) { super(`invalid oral-review output: ${reason}`); this.name = 'ReviewOutputParseError'; }
}

/**
 * Syntax-level parse only: extracts and JSON-parses the delimiter block, checks every field's
 * type and enum membership. Does NOT check question_id/evidence_turn_ids against the DB — that
 * is validateReviewOutputAgainstSession's job below, since it needs the session's persisted
 * questions/turns this function doesn't have.
 */
export function parseReviewOutputBlock(rawText: string): ReviewOutput {
  const start = rawText.indexOf(REVIEW_OUTPUT_OPEN);
  if (start < 0) throw new ReviewOutputParseError('no review output block found');
  if (rawText.indexOf(REVIEW_OUTPUT_OPEN, start + REVIEW_OUTPUT_OPEN.length) >= 0) {
    throw new ReviewOutputParseError('more than one review output block');
  }
  const end = rawText.indexOf(REVIEW_OUTPUT_CLOSE, start + REVIEW_OUTPUT_OPEN.length);
  if (end < 0) throw new ReviewOutputParseError('unterminated review output block');
  if (rawText.slice(end + REVIEW_OUTPUT_CLOSE.length).trim()) throw new ReviewOutputParseError('trailing content after review output block');

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText.slice(start + REVIEW_OUTPUT_OPEN.length, end).trim());
  } catch {
    throw new ReviewOutputParseError('review output block is not valid JSON');
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record !== 'object' || record === null || !Array.isArray(record.items)) {
    throw new ReviewOutputParseError('review output must be a JSON object with an "items" array');
  }
  if (record.items.length === 0) throw new ReviewOutputParseError('items must not be empty');

  const items: ReviewItem[] = record.items.map((raw, index) => {
    const item = raw as Record<string, unknown>;
    if (typeof item !== 'object' || item === null) throw new ReviewOutputParseError(`items[${index}] is not an object`);
    if (typeof item.question_id !== 'string' || !item.question_id) throw new ReviewOutputParseError(`items[${index}].question_id is required`);
    if (typeof item.ai_suggested_level !== 'string' || !RUBRIC_LEVELS.includes(item.ai_suggested_level as RubricLevel)) {
      throw new ReviewOutputParseError(`items[${index}].ai_suggested_level must be one of ${RUBRIC_LEVELS.join(', ')}`);
    }
    if (!Array.isArray(item.evidence_turn_ids) || !item.evidence_turn_ids.every((id) => typeof id === 'string')) {
      throw new ReviewOutputParseError(`items[${index}].evidence_turn_ids must be an array of strings`);
    }
    if (item.ai_suggested_level !== 'insufficient_evidence' && item.evidence_turn_ids.length === 0) {
      throw new ReviewOutputParseError(`items[${index}] must cite at least one evidence_turn_id unless ai_suggested_level is "insufficient_evidence"`);
    }
    if (typeof item.rationale !== 'string' || !item.rationale.trim()) throw new ReviewOutputParseError(`items[${index}].rationale is required`);
    return {
      question_id: item.question_id,
      ai_suggested_level: item.ai_suggested_level as RubricLevel,
      evidence_turn_ids: item.evidence_turn_ids as string[],
      rationale: item.rationale.trim(),
    };
  });
  return { items };
}

/**
 * DB-backed validation: every item's question_id must belong to this session, every session
 * question must be covered exactly once (no duplicates, none missing), and every cited
 * evidence_turn_id must belong to that specific question's turns. Rejects (never persists) a
 * suggestion that reaches outside the session's own questions/turns — see Phase 5's risk
 * assessment on cross-session evidence leakage.
 */
export function validateReviewOutputAgainstSession(output: ReviewOutput, sessionId: string): void {
  const questions = listQuestionsForSession(sessionId);
  const questionIds = new Set(questions.map((q) => q.question_id));

  const seen = new Set<string>();
  for (const item of output.items) {
    if (!questionIds.has(item.question_id)) {
      throw new ReviewOutputParseError(`question_id ${item.question_id} does not belong to session ${sessionId}`);
    }
    if (seen.has(item.question_id)) throw new ReviewOutputParseError(`question_id ${item.question_id} is suggested more than once`);
    seen.add(item.question_id);

    const validTurnIds = new Set(listTurnsForQuestion(item.question_id).map((t) => t.turn_id));
    for (const turnId of item.evidence_turn_ids) {
      if (!validTurnIds.has(turnId)) {
        throw new ReviewOutputParseError(`evidence_turn_id ${turnId} does not belong to question ${item.question_id}`);
      }
    }
  }
  if (seen.size !== questions.length) {
    const missing = questions.map((q) => q.question_id).filter((id) => !seen.has(id));
    throw new ReviewOutputParseError(`missing a suggestion for question(s): ${missing.join(', ')}`);
  }
}
