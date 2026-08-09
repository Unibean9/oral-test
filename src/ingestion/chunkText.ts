const CHUNK_TARGET_MIN = 500;
const CHUNK_TARGET_MAX = 1200;

/**
 * Paragraph-aware chunking for one PDF page's extracted text: splits on blank-line boundaries,
 * then greedily accumulates paragraphs up to CHUNK_TARGET_MAX before flushing — never splits a
 * paragraph mid-sentence. Used by scripts/ingest-demo-chapters.ts (kept here, not in scripts/,
 * so it is type-checked and unit-testable via src/test/e2e.ts).
 */
export function chunkPageText(text: string): string[] {
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter((p) => p.length > 0);
  const chunks: string[] = [];
  let current = '';
  for (const paragraph of paragraphs) {
    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
    if (current && candidate.length > CHUNK_TARGET_MAX) {
      chunks.push(current);
      current = paragraph;
    } else {
      current = candidate;
    }
    if (current.length >= CHUNK_TARGET_MIN && current.length <= CHUNK_TARGET_MAX) {
      chunks.push(current);
      current = '';
    }
  }
  if (current) chunks.push(current);
  return chunks;
}
