import { db } from './connection.js';

export interface CloRow {
  clo_id: string;
  course_id: string;
  clo_no: number;
  description: string;
}

const selectById = db.prepare('SELECT * FROM clos WHERE clo_id = ?');
export function getClo(cloId: string): CloRow | undefined {
  return selectById.get(cloId) as CloRow | undefined;
}

const selectByCourse = db.prepare('SELECT * FROM clos WHERE course_id = ? ORDER BY clo_no ASC');
export function listClosForCourse(courseId: string): CloRow[] {
  return selectByCourse.all(courseId) as CloRow[];
}
