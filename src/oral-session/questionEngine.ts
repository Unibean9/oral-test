import { CLAUDE_MODEL, runRawFreshSession } from '../claude-cli/spawn.js';
import { withRoomLock } from '../claude-cli/lock.js';
import { getBlueprint, listSlotsForBlueprint, type BlueprintSlotRow } from '../db/blueprints.js';
import { listChunksForChapter } from '../db/sourceChunks.js';
import { createQuestion, listQuestionsForSession, type QuestionRow } from '../db/questions.js';
import { getOralSession, endOralSession } from '../db/oralSessions.js';
import { buildExaminerPrompt } from './promptBuilder.js';
import { parseExaminerStateBlock, validateExaminerQuestionAgainstSlot, ExaminerStateParseError } from './stateParser.js';
import { enqueueSpeechPrefetch } from './questionSpeechJobs.js';

export const EXAMINER_PROMPT_VERSION = 'oral-examiner-v1';

export class UngroundableSlotError extends Error {
  constructor(slotId: string) { super(`slot ${slotId} could not be grounded in its assigned source material`); this.name = 'UngroundableSlotError'; }
}

/** First slot (in listSlotsForBlueprint's fixed order) whose question_count has not yet been met
 * by this session's persisted questions, or undefined if every slot is satisfied. */
function findNextPendingSlot(blueprintId: string, sessionId: string): BlueprintSlotRow | undefined {
  const slots = listSlotsForBlueprint(blueprintId);
  const existing = listQuestionsForSession(sessionId);
  const countBySlot = new Map<string, number>();
  for (const q of existing) countBySlot.set(q.slot_id, (countBySlot.get(q.slot_id) ?? 0) + 1);
  return slots.find((slot) => (countBySlot.get(slot.slot_id) ?? 0) < slot.question_count);
}

/**
 * The unlocked implementation, exported separately so submitTurn.ts can run it inside the SAME
 * lock acquisition as the turn it just recorded (see that module's doc comment for why turn +
 * next-question must be one atomic section, not two lock acquisitions back to back).
 */
export async function askNextQuestionLocked(sessionId: string): Promise<QuestionRow | null> {
  const session = getOralSession(sessionId);
    if (!session) throw new Error('session_not_found');
    if (session.status !== 'in_progress') return null;

    const blueprint = getBlueprint(session.blueprint_id);
    if (!blueprint) throw new Error('blueprint_not_found');
    const slot = findNextPendingSlot(session.blueprint_id, sessionId);
    if (!slot) {
      endOralSession(sessionId);
      return null;
    }

    const chunks = listChunksForChapter(slot.chapter_id);
    if (chunks.length === 0) throw new Error(`chapter ${slot.chapter_id} has no ingested source chunks — run npm run ingest:demo first`);
    const alreadyAsked = listQuestionsForSession(sessionId)
      .filter((q) => q.slot_id === slot.slot_id)
      .map((q) => q.question_text);

    const prompt = buildExaminerPrompt({ slot, chunks, alreadyAskedQuestionTexts: alreadyAsked });
    const rawResult = await runRawFreshSession(sessionId, prompt);

    let state;
    try {
      state = parseExaminerStateBlock(rawResult);
    } catch (err) {
      if (err instanceof ExaminerStateParseError) throw new Error(`oral-examiner produced an invalid state block: ${err.message}`);
      throw err;
    }

    if (state.phase === 'done') {
      if (state.stop_reason === 'ungroundable_slot') throw new UngroundableSlotError(slot.slot_id);
      // Any other done/stop_reason from a mid-plan turn is unexpected (the app, not the skill, is
      // authoritative about when every slot is satisfied) — surfaced rather than silently accepted.
      throw new Error(`oral-examiner ended with unexpected stop_reason "${state.stop_reason}" while slot ${slot.slot_id} still had unmet questions`);
    }

    if (state.slot_id !== slot.slot_id) {
      throw new Error(`oral-examiner answered about slot ${state.slot_id} but was asked about ${slot.slot_id}`);
    }
    const { chapterId, cloId } = validateExaminerQuestionAgainstSlot(state);

    return createQuestion({
      sessionId,
      slotId: slot.slot_id,
      chapterId,
      cloId,
      bloomLevel: state.bloom_level,
      sourceChunkIds: state.source_chunk_ids,
      questionText: state.question_text,
      promptVersion: EXAMINER_PROMPT_VERSION,
      modelVersion: CLAUDE_MODEL,
    });
}

/**
 * Generates and persists the next question for a session, or completes the session if every
 * blueprint slot's question_count has been satisfied. Locked per session id (claude-cli/lock.ts,
 * generic — not brainstorm-specific) so two concurrent requests can't double-invoke the CLI for
 * the same session.
 */
export async function askNextQuestion(sessionId: string): Promise<QuestionRow | null> {
  const question = await withRoomLock(sessionId, () => askNextQuestionLocked(sessionId));
  // Strictly after the lock has released — enqueueSpeechPrefetch never blocks or delays a
  // response, but scheduling it while the lock is still held would let a background prefetch
  // occupy the sidecar's single inference slot ahead of an unrelated session's foreground
  // request, since the sidecar has no concept of this app's per-session lock at all.
  if (question) enqueueSpeechPrefetch(question);
  return question;
}
