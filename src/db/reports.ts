import { v4 as uuidv4 } from 'uuid';
import { db } from './connection.js';

export interface ReportRow {
  report_id: string;
  session_id: string;
  status: 'draft' | 'approved';
  approved_by: string | null;
  approved_at: string | null;
  created_at: string;
}

const insertReport = db.prepare(
  `INSERT INTO reports (report_id, session_id, status, created_at) VALUES (?, ?, 'draft', ?)`,
);
export function createDraftReport(sessionId: string): ReportRow {
  const reportId = uuidv4();
  const now = new Date().toISOString();
  insertReport.run(reportId, sessionId, now);
  return { report_id: reportId, session_id: sessionId, status: 'draft', approved_by: null, approved_at: null, created_at: now };
}

const selectBySession = db.prepare('SELECT * FROM reports WHERE session_id = ?');
export function getReportForSession(sessionId: string): ReportRow | undefined {
  return selectBySession.get(sessionId) as ReportRow | undefined;
}

// Compare-and-set: only a `draft` report can be approved here — this is the ONLY statement in
// the codebase that may set status = 'approved'. No AI/skill code path writes this column
// directly (see src/review/draftReview.ts, which only ever produces rubric_items suggestions).
const approveStmt = db.prepare(
  `UPDATE reports SET status = 'approved', approved_by = ?, approved_at = ? WHERE session_id = ? AND status = 'draft'`,
);
export function approveReport(sessionId: string, approverTeacherId: string): boolean {
  const result = approveStmt.run(approverTeacherId, new Date().toISOString(), sessionId);
  return result.changes > 0;
}
