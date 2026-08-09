import type { AssessmentSessionRow } from '../db/oralSessions.js';
import type { ReportRow } from '../db/reports.js';
import type { RubricItemRow } from '../db/rubric.js';
import type { QuestionRow, OralTurnRow } from '../db/questions.js';

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export class ReportNotApprovedError extends Error {
  constructor(sessionId: string) { super(`report for session ${sessionId} is not approved`); this.name = 'ReportNotApprovedError'; }
}

/**
 * Pure function from already-approved DB rows to an HTML string — no AI call, no DB access of its
 * own. Refuses to render anything but an approved report, so a draft (still teacher-editable)
 * report can never be served as though it were final (Phase 5's success criteria).
 */
export function renderReportHtml(params: {
  session: AssessmentSessionRow;
  report: ReportRow;
  items: RubricItemRow[];
  questions: QuestionRow[];
  turnsByQuestionId: Map<string, OralTurnRow[]>;
}): string {
  const { session, report, items, questions, turnsByQuestionId } = params;
  if (report.status !== 'approved') throw new ReportNotApprovedError(session.session_id);

  const questionById = new Map(questions.map((q) => [q.question_id, q]));
  const rows = items.map((item) => {
    const question = questionById.get(item.question_id);
    const level = item.lecturer_override_level ?? item.ai_suggested_level ?? 'insufficient_evidence';
    const turns = turnsByQuestionId.get(item.question_id) ?? [];
    const evidenceIds = new Set(JSON.parse(item.evidence_turn_ids) as string[]);
    const evidenceHtml = turns
      .filter((t) => evidenceIds.has(t.turn_id))
      .map((t) => `<li>${escapeHtml(t.text)}</li>`)
      .join('');
    return `
      <section class="oral-report-item">
        <h3>${escapeHtml(question?.question_text ?? '(question not found)')}</h3>
        <p class="clo">CLO: ${escapeHtml(question?.clo_id ?? '')} — Bloom: ${escapeHtml(question?.bloom_level ?? '')}</p>
        <p class="level">Rubric level: <strong>${escapeHtml(level)}</strong></p>
        ${item.comment ? `<p class="comment">Nhận xét giáo viên: ${escapeHtml(item.comment)}</p>` : ''}
        <ul class="evidence">${evidenceHtml}</ul>
      </section>`;
  }).join('\n');

  return `<!DOCTYPE html>
<html lang="vi">
<head><meta charset="utf-8"><title>Báo cáo đánh giá vấn đáp — ${escapeHtml(session.student_code)}</title></head>
<body>
  <h1>Báo cáo đánh giá vấn đáp</h1>
  <p>Sinh viên: ${escapeHtml(session.student_code)}</p>
  <p>Phiên: ${escapeHtml(session.session_id)}</p>
  <p>Được duyệt: ${escapeHtml(report.approved_at ?? '')} bởi ${escapeHtml(report.approved_by ?? '')}</p>
  ${rows}
</body>
</html>`;
}
