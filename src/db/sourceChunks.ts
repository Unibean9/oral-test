import { v4 as uuidv4 } from 'uuid';
import { db } from './connection.js';

export interface SourceChunkRow {
  chunk_id: string;
  chapter_id: string;
  pdf_page: number;
  printed_page: number | null;
  content_hash: string;
  text: string;
  char_start: number | null;
  char_end: number | null;
  created_at: string;
}

// Idempotent on (chapter_id, content_hash) via the migration's unique index — a re-run of the
// ingestion script (Phase 3) upserts rather than duplicating a chunk whose text did not change.
const upsertChunk = db.prepare(`
  INSERT INTO source_chunks (chunk_id, chapter_id, pdf_page, printed_page, content_hash, text, char_start, char_end, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(chapter_id, content_hash) DO UPDATE SET
    pdf_page = excluded.pdf_page, printed_page = excluded.printed_page,
    char_start = excluded.char_start, char_end = excluded.char_end
  RETURNING chunk_id
`);
export function upsertSourceChunk(params: {
  chapterId: string; pdfPage: number; printedPage: number | null; contentHash: string;
  text: string; charStart: number | null; charEnd: number | null;
}): string {
  const chunkId = uuidv4();
  const now = new Date().toISOString();
  const row = upsertChunk.get(
    chunkId, params.chapterId, params.pdfPage, params.printedPage, params.contentHash,
    params.text, params.charStart, params.charEnd, now,
  ) as { chunk_id: string };
  return row.chunk_id;
}

const selectByChapter = db.prepare('SELECT * FROM source_chunks WHERE chapter_id = ? ORDER BY pdf_page ASC, char_start ASC');
export function listChunksForChapter(chapterId: string): SourceChunkRow[] {
  return selectByChapter.all(chapterId) as SourceChunkRow[];
}

const selectById = db.prepare('SELECT * FROM source_chunks WHERE chunk_id = ?');
export function getSourceChunk(chunkId: string): SourceChunkRow | undefined {
  return selectById.get(chunkId) as SourceChunkRow | undefined;
}

const countByChapter = db.prepare('SELECT COUNT(*) AS n FROM source_chunks WHERE chapter_id = ?');
export function countChunksForChapter(chapterId: string): number {
  return (countByChapter.get(chapterId) as { n: number }).n;
}
