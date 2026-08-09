import { createHash } from 'node:crypto';
import { CLAUDE_MODEL, runExaminerTransition } from '../claude-cli/spawn.js';
import { withRoomLock } from '../claude-cli/lock.js';
import { getBlueprint, listSlotsForBlueprint, type BlueprintSlotRow } from '../db/blueprints.js';
import { listChunksForChapter, type SourceChunkRow } from '../db/sourceChunks.js';
import { createQuestion, listQuestionsForSession, listTurnsForQuestion, type QuestionRow } from '../db/questions.js';
import { getOralSession, endOralSession, setClaudeSessionId, type AssessmentSessionRow } from '../db/oralSessions.js';
import { buildExaminerStartPrompt, buildExaminerResumePrompt } from './promptBuilder.js';
import {
  parseExaminerStateBlock, validateExaminerTransitionAgainstSlot, ExaminerStateParseError,
  type ExaminerAction, type ExaminerTransition,
} from './stateParser.js';
import { enqueueSpeechPrefetch } from './questionSpeechJobs.js';

export const EXAMINER_PROMPT_VERSION = 'oral-examiner-v2';

export class IllegalExaminerActionError extends Error {
  constructor(action: string, allowed: readonly string[]) {
    super(`oral-examiner proposed action "${action}" outside the allowed set [${allowed.join(', ')}]`);
    this.name = 'IllegalExaminerActionError';
  }
}

/** First slot (in listSlotsForBlueprint's fixed order) whose PRIMARY question_count has not yet
 * been met by this session's persisted questions, or undefined if every slot is satisfied.
 * Follow-up rows (consumes_quota=0) never count toward a slot's quota. */
function findNextPendingSlot(blueprintId: string, sessionId: string): BlueprintSlotRow | undefined {
  const slots = listSlotsForBlueprint(blueprintId);
  const primaries = listQuestionsForSession(sessionId).filter((q) => q.consumes_quota);
  const countBySlot = new Map<string, number>();
  for (const q of primaries) countBySlot.set(q.slot_id, (countBySlot.get(q.slot_id) ?? 0) + 1);
  return slots.find((slot) => (countBySlot.get(slot.slot_id) ?? 0) < slot.question_count);
}

/** Deterministic hash of every slot's (answered/required) count at the moment a session ends —
 * persisted alongside completion_reason so an approved report never has to recompute coverage
 * from rows that could since have changed shape. */
function coverageSnapshotHash(blueprintId: string, sessionId: string): string {
  const slots = listSlotsForBlueprint(blueprintId);
  const primaries = listQuestionsForSession(sessionId).filter((q) => q.consumes_quota);
  const countBySlot = new Map<string, number>();
  for (const q of primaries) countBySlot.set(q.slot_id, (countBySlot.get(q.slot_id) ?? 0) + 1);
  const snapshot = slots
    .map((s) => `${s.slot_id}:${countBySlot.get(s.slot_id) ?? 0}/${s.question_count}`)
    .sort()
    .join('|');
  return createHash('sha256').update(snapshot).digest('hex');
}

function requireChunks(slot: BlueprintSlotRow): SourceChunkRow[] {
  const chunks = listChunksForChapter(slot.chapter_id);
  if (chunks.length === 0) throw new Error(`chapter ${slot.chapter_id} has no ingested source chunks — run npm run ingest:demo first`);
  return chunks;
}

function alreadyAskedTexts(sessionId: string, slotId: string): string[] {
  return listQuestionsForSession(sessionId)
    .filter((q) => q.slot_id === slotId && q.consumes_quota)
    .map((q) => q.question_text);
}

/** One resumed CLI call, its syntax/DB validation, and the resulting DB write — the only place
 * that turns an ExaminerTransition into a persisted row or a session completion. */
async function proposeAndPersist(ctx: {
  sessionId: string;
  session: AssessmentSessionRow;
  allowed: ExaminerAction[];
  prompt: string;
  pendingSlot: BlueprintSlotRow | undefined;
  /** null on the very first (session-start) call, which may only ever propose 'advance'. */
  itemRoot: { id: string; slotId: string } | null;
}): Promise<QuestionRow | null> {
  const { text, claudeSessionId } = await runExaminerTransition(ctx.sessionId, ctx.session.claude_session_id, ctx.prompt);
  if (!ctx.session.claude_session_id) setClaudeSessionId(ctx.sessionId, claudeSessionId);

  let transition: ExaminerTransition;
  try {
    transition = parseExaminerStateBlock(text);
  } catch (err) {
    if (err instanceof ExaminerStateParseError) throw new Error(`oral-examiner produced an invalid transition: ${err.message}`);
    throw err;
  }

  if (!ctx.allowed.includes(transition.action)) throw new IllegalExaminerActionError(transition.action, ctx.allowed);

  if (transition.action === 'close') {
    // The agent's own completion_reason is advisory only — coverage truth is DB-derived, never
    // trusted from the model, per this plan's non-negotiable invariant.
    const reason = ctx.pendingSlot ? 'ended_early' : 'coverage_verified';
    endOralSession(ctx.sessionId, { reason, coverageSnapshotHash: coverageSnapshotHash(ctx.session.blueprint_id, ctx.sessionId) });
    return null;
  }

  const isAdvance = transition.action === 'advance';
  const targetSlotId = isAdvance ? ctx.pendingSlot!.slot_id : ctx.itemRoot!.slotId;
  if (transition.slot_id !== targetSlotId) {
    throw new Error(`oral-examiner targeted slot ${transition.slot_id} but the backend allowlisted only ${targetSlotId} for action "${transition.action}"`);
  }
  const { chapterId, cloId, bloomLevel } = validateExaminerTransitionAgainstSlot(transition);

  return createQuestion({
    sessionId: ctx.sessionId, slotId: targetSlotId, chapterId, cloId, bloomLevel,
    sourceChunkIds: transition.source_chunk_ids, questionText: transition.question_text,
    promptVersion: EXAMINER_PROMPT_VERSION, modelVersion: CLAUDE_MODEL,
    action: transition.action, parentQuestionId: isAdvance ? null : ctx.itemRoot!.id,
    consumesQuota: isAdvance,
  });
}

/**
 * The unlocked implementation, exported separately so submitTurn.ts can run it inside the SAME
 * lock acquisition as the turn it just recorded. `answeredQuestion` is the question the student
 * just answered (its own primary or follow-up row), or null on the very first call for a session.
 */
export async function askNextQuestionLocked(sessionId: string, answeredQuestion: QuestionRow | null): Promise<QuestionRow | null> {
  const session = getOralSession(sessionId);
  if (!session) throw new Error('session_not_found');
  if (session.status !== 'in_progress') return null;

  const blueprint = getBlueprint(session.blueprint_id);
  if (!blueprint) throw new Error('blueprint_not_found');

  const pendingSlot = findNextPendingSlot(session.blueprint_id, sessionId);

  if (!answeredQuestion) {
    if (!pendingSlot) {
      endOralSession(sessionId, { reason: 'coverage_verified', coverageSnapshotHash: coverageSnapshotHash(session.blueprint_id, sessionId) });
      return null;
    }
    return proposeAndPersist({
      sessionId, session, allowed: ['advance'], itemRoot: null, pendingSlot,
      prompt: buildExaminerStartPrompt({ slot: pendingSlot, chunks: requireChunks(pendingSlot) }),
    });
  }

  const itemRootId = answeredQuestion.parent_question_id ?? answeredQuestion.question_id;
  const itemRootSlotId = answeredQuestion.slot_id;
  const followUpsUsed = listQuestionsForSession(sessionId).filter((q) => q.parent_question_id === itemRootId).length;
  const followUpAllowed = followUpsUsed === 0;

  const allowed: ExaminerAction[] = ['close'];
  if (followUpAllowed) allowed.push('probe', 'clarify', 'challenge', 'redirect');
  if (pendingSlot) allowed.push('advance');

  // When 'close' is the only legal move, the outcome is already fully determined by DB state —
  // asking the CLI anyway would spend a call for nothing and risks IllegalExaminerActionError if
  // the model proposes something else, bricking the session for no reason (see submitOralTurn's
  // crash-recovery comment for why a mid-conversation examiner failure is otherwise unrecoverable).
  if (allowed.length === 1) {
    endOralSession(sessionId, { reason: 'coverage_verified', coverageSnapshotHash: coverageSnapshotHash(session.blueprint_id, sessionId) });
    return null;
  }

  const lastAnswer = listTurnsForQuestion(answeredQuestion.question_id).at(-1);
  const prompt = buildExaminerResumePrompt({
    studentAnswerText: lastAnswer?.text ?? '',
    currentSlotId: itemRootSlotId,
    allowedActions: allowed,
    nextSlot: pendingSlot
      ? { slot: pendingSlot, chunks: requireChunks(pendingSlot), alreadyAskedQuestionTexts: alreadyAskedTexts(sessionId, pendingSlot.slot_id) }
      : undefined,
  });

  return proposeAndPersist({
    sessionId, session, allowed, prompt, pendingSlot,
    itemRoot: { id: itemRootId, slotId: itemRootSlotId },
  });
}

/**
 * Generates and persists the session's very first question, or completes it immediately if the
 * blueprint has no slots at all. Locked per session id so two concurrent requests can't
 * double-invoke the CLI for the same session.
 */
export async function askNextQuestion(sessionId: string): Promise<QuestionRow | null> {
  const question = await withRoomLock(sessionId, () => askNextQuestionLocked(sessionId, null));
  if (question) enqueueSpeechPrefetch(question);
  return question;
}
