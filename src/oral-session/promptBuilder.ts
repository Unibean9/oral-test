import { wrapUntrusted, GROUNDING_TRAILER } from '../claude-cli/spawn.js';
import type { SourceChunkRow } from '../db/sourceChunks.js';
import type { BlueprintSlotRow } from '../db/blueprints.js';
import type { ExaminerAction } from './stateParser.js';

/**
 * First-ever prompt for a session's persisted examiner CLI session: assigns the first slot to
 * question and its ONLY citable source material. Every later turn resumes this same CLI session
 * (spawn.ts's runExaminerTransition), so it is never resent — the CLI's own conversation history
 * carries it forward.
 */
export function buildExaminerStartPrompt(params: { slot: BlueprintSlotRow; chunks: SourceChunkRow[] }): string {
  const context = JSON.stringify({
    turn: 'start',
    allowed_actions: ['advance'],
    target_slot: {
      slot_id: params.slot.slot_id, chapter_id: params.slot.chapter_id,
      clo_id: params.slot.clo_id, bloom_level: params.slot.bloom_level,
    },
    source_chunks: params.chunks.map((c) => ({ chunk_id: c.chunk_id, text: c.text })),
  }, null, 2);
  return `/oral-examiner start\n\n${wrapUntrusted(context, GROUNDING_TRAILER)}`;
}

/**
 * Every turn after the first. Sends only what changed: the student's (untrusted) answer to the
 * previous turn, the DB-derived action budget for the CURRENT item (probe/clarify/challenge/
 * redirect only while its one follow-up is unused; close always available), and — only when
 * `advance` is in the allowed set — the next pending slot's material, so the agent can act on
 * content it has not seen before without the backend resending everything already asked.
 */
export function buildExaminerResumePrompt(params: {
  studentAnswerText: string;
  currentSlotId: string;
  allowedActions: ExaminerAction[];
  nextSlot?: { slot: BlueprintSlotRow; chunks: SourceChunkRow[]; alreadyAskedQuestionTexts: string[] };
}): string {
  const context = JSON.stringify({
    turn: 'resume',
    current_slot_id: params.currentSlotId,
    allowed_actions: params.allowedActions,
    student_answer: params.studentAnswerText,
    next_slot: params.nextSlot ? {
      slot_id: params.nextSlot.slot.slot_id, chapter_id: params.nextSlot.slot.chapter_id,
      clo_id: params.nextSlot.slot.clo_id, bloom_level: params.nextSlot.slot.bloom_level,
      source_chunks: params.nextSlot.chunks.map((c) => ({ chunk_id: c.chunk_id, text: c.text })),
      already_asked: params.nextSlot.alreadyAskedQuestionTexts,
    } : null,
  }, null, 2);
  return wrapUntrusted(context, GROUNDING_TRAILER);
}
