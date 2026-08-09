import { v4 as uuidv4 } from 'uuid';
import { db } from './connection.js';

export const RUBRIC_LEVELS = ['1', '2', '3', '4', 'insufficient_evidence'] as const;
export type RubricLevel = (typeof RUBRIC_LEVELS)[number];

export interface RubricItemRow {
  item_id: string;
  question_id: string;
  ai_suggested_level: string | null;
  lecturer_override_level: string | null;
  evidence_turn_ids: string; // JSON array of turn_id
  comment: string | null;
  approver: string | null;
  approved_at: string | null;
}

const insertItem = db.prepare(
  `INSERT INTO rubric_items (item_id, question_id, ai_suggested_level, evidence_turn_ids, comment)
   VALUES (?, ?, ?, ?, NULL)`,
);
export function createRubricItem(params: { questionId: string; aiSuggestedLevel: RubricLevel; evidenceTurnIds: string[] }): RubricItemRow {
  const itemId = uuidv4();
  const evidenceJson = JSON.stringify(params.evidenceTurnIds);
  insertItem.run(itemId, params.questionId, params.aiSuggestedLevel, evidenceJson);
  return {
    item_id: itemId, question_id: params.questionId, ai_suggested_level: params.aiSuggestedLevel,
    lecturer_override_level: null, evidence_turn_ids: evidenceJson, comment: null, approver: null, approved_at: null,
  };
}

const selectBySession = db.prepare(`
  SELECT rubric_items.* FROM rubric_items
  JOIN questions ON questions.question_id = rubric_items.question_id
  WHERE questions.session_id = ?
  ORDER BY rubric_items.item_id ASC
`);
export function listRubricItemsForSession(sessionId: string): RubricItemRow[] {
  return selectBySession.all(sessionId) as RubricItemRow[];
}

const selectById = db.prepare('SELECT * FROM rubric_items WHERE item_id = ?');
export function getRubricItem(itemId: string): RubricItemRow | undefined {
  return selectById.get(itemId) as RubricItemRow | undefined;
}

const updateOverride = db.prepare(
  `UPDATE rubric_items SET lecturer_override_level = ?, comment = ? WHERE item_id = ?`,
);
export function overrideRubricItem(itemId: string, params: { lecturerOverrideLevel: RubricLevel | null; comment: string | null }): void {
  updateOverride.run(params.lecturerOverrideLevel, params.comment, itemId);
}

const approveItemsForSession = db.prepare(`
  UPDATE rubric_items SET approver = ?, approved_at = ?
  WHERE approved_at IS NULL AND question_id IN (SELECT question_id FROM questions WHERE session_id = ?)
`);
export function approveRubricItemsForSession(sessionId: string, approverTeacherId: string): void {
  approveItemsForSession.run(approverTeacherId, new Date().toISOString(), sessionId);
}
