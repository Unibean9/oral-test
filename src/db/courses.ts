import { db } from './connection.js';

export interface CourseRow {
  course_id: string;
  name: string;
  created_at: string;
}

const selectById = db.prepare('SELECT * FROM courses WHERE course_id = ?');
export function getCourse(courseId: string): CourseRow | undefined {
  return selectById.get(courseId) as CourseRow | undefined;
}

const selectAll = db.prepare('SELECT * FROM courses ORDER BY course_id ASC');
export function listCourses(): CourseRow[] {
  return selectAll.all() as CourseRow[];
}
