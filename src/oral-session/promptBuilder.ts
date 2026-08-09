import { wrapUntrusted, GROUNDING_TRAILER } from '../claude-cli/spawn.js';
import type { SourceChunkRow } from '../db/sourceChunks.js';
import type { BlueprintSlotRow } from '../db/blueprints.js';

/**
 * Builds the full-context prompt for one oral-examiner invocation: which slot to ask about, the
 * ONLY source material it may cite, and the questions already asked for that slot (so it doesn't
 * repeat itself). Every call is self-contained — see spawn.ts's runRawFreshSession doc comment
 * for why no conversational session memory is used here.
 */
export function buildExaminerPrompt(params: {
  slot: BlueprintSlotRow;
  chunks: SourceChunkRow[];
  alreadyAskedQuestionTexts: string[];
}): string {
  const chunkPayload = params.chunks.map((c) => ({ chunk_id: c.chunk_id, text: c.text }));
  const context = JSON.stringify({
    slot_id: params.slot.slot_id,
    chapter_id: params.slot.chapter_id,
    clo_id: params.slot.clo_id,
    bloom_level: params.slot.bloom_level,
    source_chunks: chunkPayload,
    already_asked: params.alreadyAskedQuestionTexts,
  }, null, 2);
  // Book text is treated as untrusted-but-groundable material, same trailer wording used for
  // fresh grounded sessions elsewhere in this codebase — a defense-in-depth measure in case a
  // PDF ever contains adversarial text, not an expectation that it will.
  return `/oral-examiner start\n\n${wrapUntrusted(context, GROUNDING_TRAILER)}`;
}
