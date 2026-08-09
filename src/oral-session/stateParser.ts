import { getBlueprintSlot } from '../db/blueprints.js';
import { getSourceChunk } from '../db/sourceChunks.js';

export const EXAMINER_STATE_OPEN = '<oral-examiner-state>';
export const EXAMINER_STATE_CLOSE = '</oral-examiner-state>';

const PHASES = new Set(['asking', 'done']);
const NEXT_ACTIONS = new Set(['awaiting_answer', 'none']);
const STOP_REASONS = new Set(['all_slots_answered', 'ungroundable_slot', 'teacher_ended']);

export interface ExaminerState {
  phase: 'asking' | 'done';
  slot_id: string;
  question_text: string;
  bloom_level: string;
  source_chunk_ids: string[];
  next_action: 'awaiting_answer' | 'none';
  stop_reason: string | null;
}

export class ExaminerStateParseError extends Error {
  constructor(reason: string) { super(`invalid oral-examiner state: ${reason}`); this.name = 'ExaminerStateParseError'; }
}

/**
 * Syntax-level parse only: extracts and JSON-parses the delimiter block, checks every field's
 * TYPE and enum membership. Does NOT check the value against the DB (slot exists, chunk belongs
 * to the slot's chapter, etc.) — that is validateAgainstSession's job below, since it needs a
 * session's blueprint context this function doesn't have.
 */
export function parseExaminerStateBlock(rawText: string): ExaminerState {
  const start = rawText.indexOf(EXAMINER_STATE_OPEN);
  if (start < 0) throw new ExaminerStateParseError('no state block found');
  if (rawText.indexOf(EXAMINER_STATE_OPEN, start + EXAMINER_STATE_OPEN.length) >= 0) {
    throw new ExaminerStateParseError('more than one state block');
  }
  const end = rawText.indexOf(EXAMINER_STATE_CLOSE, start + EXAMINER_STATE_OPEN.length);
  if (end < 0) throw new ExaminerStateParseError('unterminated state block');
  if (rawText.slice(end + EXAMINER_STATE_CLOSE.length).trim()) throw new ExaminerStateParseError('trailing content after state block');

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText.slice(start + EXAMINER_STATE_OPEN.length, end).trim());
  } catch {
    throw new ExaminerStateParseError('state block is not valid JSON');
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record !== 'object' || record === null) throw new ExaminerStateParseError('state block is not a JSON object');
  if (typeof record.phase !== 'string' || !PHASES.has(record.phase)) throw new ExaminerStateParseError('phase must be "asking" or "done"');
  if (typeof record.slot_id !== 'string' || !record.slot_id) throw new ExaminerStateParseError('slot_id is required');
  if (typeof record.next_action !== 'string' || !NEXT_ACTIONS.has(record.next_action)) throw new ExaminerStateParseError('next_action must be "awaiting_answer" or "none"');
  if (record.stop_reason !== null && (typeof record.stop_reason !== 'string' || !STOP_REASONS.has(record.stop_reason))) {
    throw new ExaminerStateParseError('stop_reason must be null or a known reason');
  }
  if (record.phase === 'asking') {
    if (typeof record.question_text !== 'string' || !record.question_text.trim()) throw new ExaminerStateParseError('question_text is required when phase is "asking"');
    if (typeof record.bloom_level !== 'string' || !record.bloom_level) throw new ExaminerStateParseError('bloom_level is required when phase is "asking"');
    if (!Array.isArray(record.source_chunk_ids) || record.source_chunk_ids.length === 0 || !record.source_chunk_ids.every((id) => typeof id === 'string')) {
      throw new ExaminerStateParseError('source_chunk_ids must be a non-empty array of strings when phase is "asking"');
    }
    if (record.stop_reason !== null) throw new ExaminerStateParseError('stop_reason must be null while phase is "asking"');
  } else {
    if (record.stop_reason === null) throw new ExaminerStateParseError('stop_reason is required when phase is "done"');
    if (record.next_action !== 'none') throw new ExaminerStateParseError('next_action must be "none" when phase is "done"');
  }
  return {
    phase: record.phase as 'asking' | 'done',
    slot_id: record.slot_id,
    question_text: typeof record.question_text === 'string' ? record.question_text.trim() : '',
    bloom_level: typeof record.bloom_level === 'string' ? record.bloom_level : '',
    source_chunk_ids: Array.isArray(record.source_chunk_ids) ? (record.source_chunk_ids as string[]) : [],
    next_action: record.next_action as 'awaiting_answer' | 'none',
    stop_reason: (record.stop_reason as string | null) ?? null,
  };
}

/**
 * DB-backed validation for an "asking" state: the slot must belong to the session's blueprint,
 * the bloom_level must match the slot's assigned level, and every cited chunk_id must belong to
 * that slot's chapter. Rejects (never persists) a citation that reaches outside the assigned
 * chunk set — see Phase 4's success criteria.
 */
export function validateExaminerQuestionAgainstSlot(state: ExaminerState): { chapterId: string; cloId: string } {
  if (state.phase !== 'asking') throw new ExaminerStateParseError('validateExaminerQuestionAgainstSlot called on a non-asking state');
  const slot = getBlueprintSlot(state.slot_id);
  if (!slot) throw new ExaminerStateParseError(`slot_id ${state.slot_id} does not exist`);
  if (slot.bloom_level !== state.bloom_level) throw new ExaminerStateParseError(`bloom_level ${state.bloom_level} does not match slot ${state.slot_id}'s assigned level ${slot.bloom_level}`);
  for (const chunkId of state.source_chunk_ids) {
    const chunk = getSourceChunk(chunkId);
    if (!chunk || chunk.chapter_id !== slot.chapter_id) {
      throw new ExaminerStateParseError(`source_chunk_id ${chunkId} is not part of slot ${state.slot_id}'s assigned chapter`);
    }
  }
  return { chapterId: slot.chapter_id, cloId: slot.clo_id };
}
