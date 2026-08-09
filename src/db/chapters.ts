import { db } from './connection.js';

export interface ChapterRow {
  chapter_id: string;
  course_id: string;
  chapter_no: number;
  title: string;
  source_file: string;
  pdf_page_start: number;
  pdf_page_end: number;
  printed_page_start: number | null;
  printed_page_end: number | null;
  page_offset: number;
  is_demo_included: number;
}

const selectById = db.prepare('SELECT * FROM chapters WHERE chapter_id = ?');
export function getChapter(chapterId: string): ChapterRow | undefined {
  return selectById.get(chapterId) as ChapterRow | undefined;
}

const selectByCourse = db.prepare('SELECT * FROM chapters WHERE course_id = ? ORDER BY chapter_no ASC');
export function listChaptersForCourse(courseId: string): ChapterRow[] {
  return selectByCourse.all(courseId) as ChapterRow[];
}

// Every chapter this MVP knows about is demo-included (seeded by migrate.ts's migrationV7) —
// this filter exists so a future non-demo chapter insert (full-book ingestion, out of scope here)
// cannot silently become reachable by list/select call sites without an explicit code change.
const selectDemoIncluded = db.prepare('SELECT * FROM chapters WHERE is_demo_included = 1 ORDER BY course_id ASC, chapter_no ASC');
export function listDemoChapters(): ChapterRow[] {
  return selectDemoIncluded.all() as ChapterRow[];
}
