import { runRawFreshSession, wrapUntrusted, GROUNDING_TRAILER } from '../claude-cli/spawn.js';
import { withRoomLock } from '../claude-cli/lock.js';
import { getOralSession, setOralSessionStatus } from '../db/oralSessions.js';
import { listQuestionsForSession, listTurnsForQuestion } from '../db/questions.js';
import { getClo } from '../db/clos.js';
import { RUBRIC_LEVELS, createRubricItem, type RubricItemRow } from '../db/rubric.js';
import { createDraftReport, getReportForSession, type ReportRow } from '../db/reports.js';
import { parseReviewOutputBlock, validateReviewOutputAgainstSession, ReviewOutputParseError } from './validateReviewOutput.js';

export const REVIEW_PROMPT_VERSION = 'oral-assessment-reviewer-v1';

export class SessionNotCompletedError extends Error {
  constructor(sessionId: string) { super(`session ${sessionId} is not completed`); this.name = 'SessionNotCompletedError'; }
}
export class ReportAlreadyExistsError extends Error {
  constructor(sessionId: string) { super(`session ${sessionId} already has a report`); this.name = 'ReportAlreadyExistsError'; }
}

/**
 * Builds the read-only snapshot payload the skill is allowed to see: this session's own
 * questions, their CLO/bloom context, and the verbatim turns answering each one. No other
 * session's rows are ever queried here — see Phase 5's risk assessment on cross-session leakage.
 */
function buildReviewSnapshot(sessionId: string) {
  const questions = listQuestionsForSession(sessionId);
  return {
    session_id: sessionId,
    rubric_levels: RUBRIC_LEVELS,
    questions: questions.map((q) => ({
      question_id: q.question_id,
      clo: { clo_id: q.clo_id, description: getClo(q.clo_id)?.description ?? '' },
      bloom_level: q.bloom_level,
      question_text: q.question_text,
      turns: listTurnsForQuestion(q.question_id).map((t) => ({ turn_id: t.turn_id, input_mode: t.input_mode, text: t.text })),
    })),
  };
}

/**
 * Runs the oral-assessment-reviewer skill once per completed session, in a fresh Claude session
 * with no continuity to the examiner session (Phase 5's fresh-session-separation principle), and
 * persists its suggestions as draft rubric_items + a draft report. The skill never sets
 * report.status = 'approved' — that transition exists only in reports.ts's approveReport, called
 * from the teacher-triggered approve route.
 */
export async function draftReview(sessionId: string): Promise<{ report: ReportRow; items: RubricItemRow[] }> {
  return withRoomLock(sessionId, async () => {
    const session = getOralSession(sessionId);
    if (!session) throw new Error('session_not_found');
    // Checked before the status check: a successful review moves the session to 'reviewed', so a
    // re-run would otherwise surface as the less specific "not completed" instead of "already reviewed".
    if (getReportForSession(sessionId)) throw new ReportAlreadyExistsError(sessionId);
    if (session.status !== 'completed') throw new SessionNotCompletedError(sessionId);

    const snapshot = buildReviewSnapshot(sessionId);
    if (snapshot.questions.length === 0) throw new Error(`session ${sessionId} has no questions to review`);

    const context = JSON.stringify(snapshot, null, 2);
    const prompt = `/oral-assessment-reviewer start\n\n${wrapUntrusted(context, GROUNDING_TRAILER)}`;
    const raw = await runRawFreshSession(sessionId, prompt);

    let output;
    try {
      output = parseReviewOutputBlock(raw);
    } catch (err) {
      if (err instanceof ReviewOutputParseError) throw new Error(`oral-assessment-reviewer produced invalid output: ${err.message}`);
      throw err;
    }
    validateReviewOutputAgainstSession(output, sessionId);

    const items = output.items.map((item) =>
      createRubricItem({ questionId: item.question_id, aiSuggestedLevel: item.ai_suggested_level, evidenceTurnIds: item.evidence_turn_ids }),
    );
    const report = createDraftReport(sessionId);
    setOralSessionStatus(sessionId, 'reviewed');
    return { report, items };
  });
}

