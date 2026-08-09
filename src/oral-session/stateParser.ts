import { getBlueprintSlot } from '../db/blueprints.js';
import { getSourceChunk } from '../db/sourceChunks.js';

export const EXAMINER_STATE_OPEN = '<oral-examiner-state>';
export const EXAMINER_STATE_CLOSE = '</oral-examiner-state>';

export type ExaminerAction = 'advance' | 'probe' | 'clarify' | 'challenge' | 'redirect' | 'close';
export type ExaminerDisposition = 'continue' | 'complete';
export type ExaminerCompletionReason = 'coverage_verified' | 'ended_early';

const ACTIONS = new Set<ExaminerAction>(['advance', 'probe', 'clarify', 'challenge', 'redirect', 'close']);
const DISPOSITIONS = new Set<ExaminerDisposition>(['continue', 'complete']);
const COMPLETION_REASONS = new Set<ExaminerCompletionReason>(['coverage_verified', 'ended_early']);

/**
 * One examiner turn's proposal. `bloom_level` is deliberately not part of this contract: the
 * agent targets a `slot_id` the backend already assigned a Bloom level to, and the backend always
 * uses that DB value rather than trusting an echoed one — one less field the agent could get
 * subtly wrong. `completion_reason` is likewise advisory only: questionEngine.ts always recomputes
 * it from live coverage state before persisting, never from what the agent claims.
 */
export interface ExaminerTransition {
  action: ExaminerAction;
  slot_id: string;
  question_text: string;
  source_chunk_ids: string[];
  disposition: ExaminerDisposition;
  completion_reason: ExaminerCompletionReason | null;
}

export class ExaminerStateParseError extends Error {
  constructor(reason: string) { super(`invalid oral-examiner transition: ${reason}`); this.name = 'ExaminerStateParseError'; }
}

/**
 * Syntax-level parse only: extracts and JSON-parses the delimiter block, checks every field's
 * TYPE and enum membership. Does NOT check a value against the DB (slot exists, chunk belongs to
 * the slot's chapter, etc.) — that is validateExaminerTransitionAgainstSlot's job below.
 */
export function parseExaminerStateBlock(rawText: string): ExaminerTransition {
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
  if (typeof record.action !== 'string' || !ACTIONS.has(record.action as ExaminerAction)) {
    throw new ExaminerStateParseError('action must be one of advance, probe, clarify, challenge, redirect, close');
  }
  if (typeof record.slot_id !== 'string' || !record.slot_id) throw new ExaminerStateParseError('slot_id is required');
  if (typeof record.disposition !== 'string' || !DISPOSITIONS.has(record.disposition as ExaminerDisposition)) {
    throw new ExaminerStateParseError('disposition must be "continue" or "complete"');
  }
  const action = record.action as ExaminerAction;
  const disposition = record.disposition as ExaminerDisposition;

  if (action === 'close') {
    if (disposition !== 'complete') throw new ExaminerStateParseError('disposition must be "complete" when action is "close"');
    if (record.completion_reason !== null && (typeof record.completion_reason !== 'string' || !COMPLETION_REASONS.has(record.completion_reason as ExaminerCompletionReason))) {
      throw new ExaminerStateParseError('completion_reason must be null or a known reason');
    }
  } else {
    if (disposition !== 'continue') throw new ExaminerStateParseError('disposition must be "continue" unless action is "close"');
    if (record.completion_reason !== undefined && record.completion_reason !== null) {
      throw new ExaminerStateParseError('completion_reason must be null unless action is "close"');
    }
    if (typeof record.question_text !== 'string' || !record.question_text.trim()) {
      throw new ExaminerStateParseError('question_text is required unless action is "close"');
    }
    if (!Array.isArray(record.source_chunk_ids) || record.source_chunk_ids.length === 0 || !record.source_chunk_ids.every((id) => typeof id === 'string')) {
      throw new ExaminerStateParseError('source_chunk_ids must be a non-empty array of strings unless action is "close"');
    }
  }

  return {
    action,
    slot_id: record.slot_id,
    question_text: typeof record.question_text === 'string' ? record.question_text.trim() : '',
    source_chunk_ids: Array.isArray(record.source_chunk_ids) ? (record.source_chunk_ids as string[]) : [],
    disposition,
    completion_reason: (record.completion_reason as ExaminerCompletionReason | null | undefined) ?? null,
  };
}

/**
 * DB-backed validation for a non-close transition: the slot must exist, and every cited chunk_id
 * must belong to that slot's chapter. Rejects (never persists) a citation that reaches outside the
 * assigned chunk set. Returns the slot's own chapter/CLO/bloom_level — the backend's authoritative
 * values, never the agent's.
 */
export function validateExaminerTransitionAgainstSlot(state: ExaminerTransition): { chapterId: string; cloId: string; bloomLevel: string } {
  if (state.action === 'close') throw new ExaminerStateParseError('validateExaminerTransitionAgainstSlot called on a close transition');
  const slot = getBlueprintSlot(state.slot_id);
  if (!slot) throw new ExaminerStateParseError(`slot_id ${state.slot_id} does not exist`);
  for (const chunkId of state.source_chunk_ids) {
    const chunk = getSourceChunk(chunkId);
    if (!chunk || chunk.chapter_id !== slot.chapter_id) {
      throw new ExaminerStateParseError(`source_chunk_id ${chunkId} is not part of slot ${state.slot_id}'s assigned chapter`);
    }
  }
  return { chapterId: slot.chapter_id, cloId: slot.clo_id, bloomLevel: slot.bloom_level };
}
