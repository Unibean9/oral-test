import { db } from './connection.js';

export interface BlueprintRow {
  blueprint_id: string;
  course_id: string;
  name: string;
  created_at: string;
}

export interface BlueprintSlotRow {
  slot_id: string;
  blueprint_id: string;
  chapter_id: string;
  clo_id: string;
  bloom_level: string;
  question_count: number;
  difficulty_hint: number | null;
}

// Read-only: no insert/update/delete function exists in this module by design — blueprints are
// static seed data in this MVP (migrate.ts's migrationV7), not a teacher-authored artifact. A
// real authoring workflow is a deferred, later-phase concern (see plan.md).

const selectAll = db.prepare('SELECT * FROM blueprints ORDER BY course_id ASC, created_at ASC');
export function listBlueprints(): BlueprintRow[] {
  return selectAll.all() as BlueprintRow[];
}

const selectById = db.prepare('SELECT * FROM blueprints WHERE blueprint_id = ?');
export function getBlueprint(blueprintId: string): BlueprintRow | undefined {
  return selectById.get(blueprintId) as BlueprintRow | undefined;
}

const selectByCourse = db.prepare('SELECT * FROM blueprints WHERE course_id = ? ORDER BY created_at ASC');
export function listBlueprintsByCourse(courseId: string): BlueprintRow[] {
  return selectByCourse.all(courseId) as BlueprintRow[];
}

const selectSlotsByBlueprint = db.prepare('SELECT * FROM blueprint_slots WHERE blueprint_id = ? ORDER BY chapter_id ASC, bloom_level ASC');
export function listSlotsForBlueprint(blueprintId: string): BlueprintSlotRow[] {
  return selectSlotsByBlueprint.all(blueprintId) as BlueprintSlotRow[];
}

const selectSlotById = db.prepare('SELECT * FROM blueprint_slots WHERE slot_id = ?');
export function getBlueprintSlot(slotId: string): BlueprintSlotRow | undefined {
  return selectSlotById.get(slotId) as BlueprintSlotRow | undefined;
}
