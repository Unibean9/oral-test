#!/usr/bin/env node
/**
 * Live smoke test: exercises the real `claude` CLI for both skills (oral-examiner,
 * oral-assessment-reviewer) end to end — no seam mock — and writes the full transcript (prompts,
 * raw CLI output, parsed questions/answers/review items, the rendered report) to
 * plans/260809-1724-oral-test-mvp-revised/reports/. Everything else in this repo's test suite
 * (`npm test`) mocks the CLI so it stays fast/free/deterministic; this script is the one place
 * that spends real API cost and real wall-clock time to prove the actual skill prompts, not just
 * the parsing/validation code around them, work against a live model.
 *
 * No real book PDFs are available in this environment (npm run ingest:demo requires the user to
 * supply them locally), so this script seeds ONE demo chapter with a short, clearly-labeled
 * substitute paragraph instead of real extracted book text — sufficient to prove the live
 * CLI/skill/prompt/parsing pipeline works, not a stand-in for real ingested content. It also
 * only runs 2 of the SWR blueprint's 15 questions (bounded real-CLI cost for a smoke test), then
 * force-completes the session before handing it to the reviewer skill.
 *
 * Usage: tsx scripts/live-smoke-test.ts
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { v4 as uuidv4 } from 'uuid';

process.env.DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'oral-test-live-db-')), 'oral-test.db');

const { runMigrations } = await import('../src/db/migrate.js');
const { db } = await import('../src/db/connection.js');
runMigrations(db);

const { registerTeacherWithPassword } = await import('../src/db/teachers.js');
const { upsertSourceChunk } = await import('../src/db/sourceChunks.js');
const { createOralSession, getOralSession } = await import('../src/db/oralSessions.js');
const { listTurnsForQuestion, listQuestionsForSession } = await import('../src/db/questions.js');
const { askNextQuestion } = await import('../src/oral-session/questionEngine.js');
const { submitOralTurn } = await import('../src/oral-session/submitTurn.js');
const { draftReview } = await import('../src/review/draftReview.js');
const { approveReport, getReportForSession } = await import('../src/db/reports.js');
const { listRubricItemsForSession } = await import('../src/db/rubric.js');
const { renderReportHtml } = await import('../src/report/renderReport.js');

// SAMPLE TEXT for each demo chapter — not the real book (no source PDF available locally for
// this smoke test), written to be plausibly groundable against that chapter's assigned CLO so
// the live skill has real material to cite, not a stand-in for real ingested book content.
const SAMPLE_TEXT: Record<string, string> = {
  'SWR-1':
    'SAMPLE TEXT (not the real book). A software requirement describes what a system must do or ' +
    'a quality it must have, from the perspective of stakeholders who will use or be affected by ' +
    'the system. Good requirements are verifiable: a reader can determine, without ambiguity, ' +
    'whether the built system satisfies them. Requirements should be kept distinct from design ' +
    'decisions — a requirement states a need, while a design decision states one way among ' +
    'several to satisfy that need.',
  'SWR-2':
    'SAMPLE TEXT (not the real book). Requirements elicitation is the activity of discovering what ' +
    'stakeholders actually need, as distinct from what they first say they want. Common elicitation ' +
    'techniques include structured interviews, workshops with representative users, observation of ' +
    'people doing their current work, and prototyping to surface reactions a plain description would ' +
    'not. No single technique elicits every kind of requirement well: interviews surface stated goals, ' +
    'observation surfaces tacit knowledge the stakeholder may not think to mention, and prototyping ' +
    'surfaces reactions to concrete behavior rather than abstract descriptions.',
  'SWR-3':
    'SAMPLE TEXT (not the real book). Requirements validation checks that a specified requirement is ' +
    'correct, complete, and reflects real stakeholder need, as opposed to verification, which checks ' +
    'that a built system satisfies the requirements as written. Validation techniques include reviews ' +
    'and inspections by people other than the author, requirements-based test-case derivation performed ' +
    'before implementation begins, and walking a requirement through concrete usage scenarios to catch ' +
    'gaps a purely textual reading of the requirement would miss.',
};

const transcript: string[] = [];
function log(section: string, body: string) {
  transcript.push(`\n## ${section}\n\n${body}\n`);
  console.log(`\n=== ${section} ===\n${body}`);
}

// Per-chapter answer pools the script cycles through — plausible restatements of the chapter's
// substitute text, not AI-generated, so the reviewer skill has real (if repetitive) content to
// judge rather than placeholder noise.
const ANSWER_POOLS: Record<string, string[]> = {
  'SWR-1': [
    'Một yêu cầu phần mềm mô tả điều hệ thống phải làm hoặc một chất lượng nó phải có, nhìn từ góc độ các bên liên quan.',
    'Yêu cầu tốt phải kiểm chứng được: người đọc có thể xác định rõ ràng hệ thống có thỏa mãn hay không, và yêu cầu khác với quyết định thiết kế.',
    'Yêu cầu nêu ra một nhu cầu, còn quyết định thiết kế là một trong nhiều cách để đáp ứng nhu cầu đó.',
  ],
  'SWR-2': [
    'Elicitation là hoạt động khám phá nhu cầu thực sự của các bên liên quan, khác với điều họ nói ban đầu.',
    'Các kỹ thuật elicitation phổ biến gồm phỏng vấn có cấu trúc, workshop với người dùng đại diện, quan sát công việc thực tế, và làm prototype.',
    'Không có kỹ thuật nào elicit tốt mọi loại yêu cầu: phỏng vấn thu được mục tiêu đã nêu, quan sát thu được kiến thức ngầm, prototype thu được phản ứng cụ thể.',
  ],
  'SWR-3': [
    'Validation kiểm tra xem yêu cầu đã đặc tả có đúng, đầy đủ và phản ánh đúng nhu cầu thực sự hay không.',
    'Validation khác verification: verification kiểm tra hệ thống đã xây có thỏa mãn yêu cầu như đã viết hay không.',
    'Kỹ thuật validation gồm review/inspection bởi người khác tác giả, viết test case từ yêu cầu trước khi code, và đi qua các kịch bản sử dụng cụ thể.',
  ],
};

async function main() {
  const teacher = registerTeacherWithPassword(`live-${uuidv4().slice(0, 8)}`, 'GV Live Smoke Test', 'unused-hash-placeholder');
  for (const [chapterId, text] of Object.entries(SAMPLE_TEXT)) {
    const contentHash = createHash('sha256').update(text).digest('hex');
    upsertSourceChunk({ chapterId, pdfPage: 36, printedPage: 3, contentHash, text, charStart: 0, charEnd: text.length });
  }

  log('Setup', [
    `Teacher: ${teacher.teacher_id} (code ${teacher.code})`,
    `Seeded chapters: ${Object.keys(SAMPLE_TEXT).join(', ')}, 1 substitute source chunk each (see SAMPLE_TEXT note above).`,
    `DB: ${process.env.DB_PATH}`,
  ].join('\n'));

  const session = createOralSession({ blueprintId: 'bp_swr_demo_v1', teacherId: teacher.teacher_id, studentCode: 'LIVE-SMOKE-01' });
  log('Session started', `session_id=${session.session_id} blueprint=bp_swr_demo_v1 (full run: all 15 blueprint questions, one resumed CLI session, live CLI for every turn)`);

  // Drives the real conversation the same way the HTTP layer does: one persisted CLI session,
  // resumed via submitOralTurn on every turn after the first — never re-calling askNextQuestion
  // directly, since that only ever proposes the session-start turn shape.
  const answerCursor: Record<string, number> = {};
  const turnLatenciesMs: number[] = [];
  let questionNo = 0;
  const t0 = Date.now();
  let question = await askNextQuestion(session.session_id);
  turnLatenciesMs.push(Date.now() - t0);
  while (question) {
    questionNo += 1;
    log(`Question ${questionNo} (${turnLatenciesMs[turnLatenciesMs.length - 1]}ms)`, [
      `slot_id=${question.slot_id} chapter_id=${question.chapter_id} clo_id=${question.clo_id} bloom_level=${question.bloom_level} action=${question.action}`,
      `question_text: ${question.question_text}`,
      `source_chunk_ids: ${question.source_chunk_ids}`,
    ].join('\n'));
    const pool = ANSWER_POOLS[question.chapter_id] ?? ['(no answer pool for this chapter)'];
    const idx = (answerCursor[question.chapter_id] = (answerCursor[question.chapter_id] ?? 0) + 1) - 1;
    const answerText = pool[idx % pool.length];

    const tTurn = Date.now();
    const { turn, nextQuestion } = await submitOralTurn({ sessionId: session.session_id, questionId: question.question_id, inputMode: 'typed', text: answerText });
    turnLatenciesMs.push(Date.now() - tTurn);
    log(`Answer ${questionNo} (recorded by this script, not AI-generated)`, `turn_id=${turn.turn_id}\ntext: ${answerText}`);
    question = nextQuestion;
  }
  const avgMs = Math.round(turnLatenciesMs.reduce((a, b) => a + b, 0) / turnLatenciesMs.length);
  const maxMs = Math.max(...turnLatenciesMs);
  log('Blueprint exhausted', [
    `${questionNo} question(s) asked across ${turnLatenciesMs.length} live examiner CLI call(s).`,
    `latency: avg=${avgMs}ms max=${maxMs}ms all=[${turnLatenciesMs.join(', ')}]`,
    `completion_reason=${getOralSession(session.session_id)?.completion_reason} claude_session_id=${getOralSession(session.session_id)?.claude_session_id}`,
  ].join('\n'));

  const t1 = Date.now();
  const { report, items } = await draftReview(session.session_id);
  const reviewElapsedMs = Date.now() - t1;
  log(`Review drafted (${reviewElapsedMs}ms)`, items.map((item) => {
    const q = listQuestionsForSession(session.session_id).find((q) => q.question_id === item.question_id);
    return [
      `question: ${q?.question_text}`,
      `ai_suggested_level: ${item.ai_suggested_level}`,
      `evidence_turn_ids: ${item.evidence_turn_ids}`,
      `rationale: ${item.rationale}`,
    ].join('\n');
  }).join('\n---\n'));

  approveReport(session.session_id, teacher.teacher_id);
  const finalReport = getReportForSession(session.session_id)!;
  const finalItems = listRubricItemsForSession(session.session_id);
  const questions = listQuestionsForSession(session.session_id);
  const turnsByQuestionId = new Map(questions.map((q) => [q.question_id, listTurnsForQuestion(q.question_id)]));
  const html = renderReportHtml({ session: getOralSession(session.session_id)!, report: finalReport, items: finalItems, questions, turnsByQuestionId });
  log('Report approved and rendered', `report_id=${finalReport.report_id} status=${finalReport.status} approved_by=${finalReport.approved_by}`);

  const reportsDir = path.resolve('plans/260809-1724-oral-test-mvp-revised/reports');
  fs.mkdirSync(reportsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const transcriptPath = path.join(reportsDir, `phase7-live-transcript-${stamp}.md`);
  const htmlPath = path.join(reportsDir, `phase7-live-report-${stamp}.html`);
  fs.writeFileSync(transcriptPath, `# Phase 7 live smoke-test transcript\n\nGenerated ${new Date().toISOString()}. Real \`claude\` CLI calls (no seam mock) for both skills.\n${transcript.join('')}`, 'utf8');
  fs.writeFileSync(htmlPath, html, 'utf8');
  console.log(`\nTranscript written to ${transcriptPath}`);
  console.log(`Rendered report written to ${htmlPath}`);
}

main().catch((err) => {
  console.error('[live-phase7-smoke-test] failed:', err);
  process.exitCode = 1;
});
