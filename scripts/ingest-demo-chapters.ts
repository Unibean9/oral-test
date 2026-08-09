#!/usr/bin/env node
/**
 * One-time offline preprocessing: extracts text for exactly the 5 chapters named in
 * demo-chapter-registry.json into the `source_chunks` table (see src/db/migrate.ts's
 * migrationV7, which already seeded the `chapters`/`courses`/`clos`/`blueprints` rows this
 * script's inserts join against).
 *
 * REQUIRES the `pdftotext` CLI (poppler) on PATH — confirmed present at /mingw64/bin/pdftotext
 * on the reference dev machine. This is a one-time, offline, developer-run step, not a runtime
 * dependency of the deployed app (see plan.md's Phase 3 risk note). If pdftotext is missing,
 * this script fails loud with an actionable message rather than a cryptic ENOENT.
 *
 * Usage:
 *   tsx scripts/ingest-demo-chapters.ts --pdf-dir <dir containing the two source PDFs>
 *
 * Never commit or sync the extracted text: it stays local-only in the SQLite DB (data/rooms.db,
 * already gitignored) — same trust boundary as the rest of that file.
 */
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface RegistryChapter {
  chapterId: string;
  courseId: string;
  chapterNo: number;
  title: string;
  sourceFile: string;
  pdfPageStart: number;
  pdfPageEnd: number;
  pageOffset: number;
}

function loadRegistry(): RegistryChapter[] {
  const registryPath = path.resolve(__dirname, 'demo-chapter-registry.json');
  const raw = JSON.parse(fs.readFileSync(registryPath, 'utf8')) as { chapters: RegistryChapter[] };
  return raw.chapters;
}

function parseArgs(argv: string[]): { pdfDir: string } {
  const idx = argv.indexOf('--pdf-dir');
  if (idx === -1 || !argv[idx + 1]) {
    throw new Error('Usage: tsx scripts/ingest-demo-chapters.ts --pdf-dir <dir containing the source PDFs>');
  }
  return { pdfDir: argv[idx + 1] };
}

function checkPdftotextAvailable(): void {
  // `pdftotext -v` itself exits non-zero (poppler quirk: it still prints the version banner), so
  // any response at all — not a zero exit code — is what proves the binary is on PATH. Only a
  // spawn-level failure (ENOENT: no such file) means it is genuinely missing.
  const result = spawnSync('pdftotext', ['-v'], { stdio: 'ignore' });
  if (result.error) {
    throw new Error(
      'pdftotext (poppler) was not found on PATH. This script requires it for one-time PDF text ' +
      `extraction — install poppler-utils and retry. Original error: ${result.error.message}`,
    );
  }
}

/** Extracts one page's text via `-f N -l N` (single-page range), never a multi-page `-layout`
 * span — a wider range loses per-page attribution, which every source_chunks row needs. */
function extractPageText(pdfPath: string, page: number): string {
  return execFileSync('pdftotext', ['-layout', '-f', String(page), '-l', String(page), pdfPath, '-'], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
}

async function main() {
  const { pdfDir } = parseArgs(process.argv.slice(2));
  checkPdftotextAvailable();
  const registry = loadRegistry();

  const { getChapter } = await import('../src/db/chapters.js');
  const { upsertSourceChunk, countChunksForChapter } = await import('../src/db/sourceChunks.js');
  const { chunkPageText } = await import('../src/ingestion/chunkText.js');

  let totalChunks = 0;
  for (const chapter of registry) {
    // Hard-fail-outside-registry guard: refuse to proceed unless the migration already seeded
    // this exact chapter_id — a registry entry with no matching DB row is a config drift, not
    // something to silently paper over by inserting a fresh chapters row here.
    const dbChapter = getChapter(chapter.chapterId);
    if (!dbChapter) {
      throw new Error(`Registry chapter ${chapter.chapterId} has no matching row in chapters — run db migrations first (migrationV7).`);
    }
    if (dbChapter.pdf_page_start !== chapter.pdfPageStart || dbChapter.pdf_page_end !== chapter.pdfPageEnd) {
      throw new Error(`Registry/DB page-range mismatch for ${chapter.chapterId}: DB has ${dbChapter.pdf_page_start}-${dbChapter.pdf_page_end}, registry has ${chapter.pdfPageStart}-${chapter.pdfPageEnd}.`);
    }

    const pdfPath = path.resolve(pdfDir, chapter.sourceFile);
    if (!fs.existsSync(pdfPath)) {
      throw new Error(`Source PDF not found: ${pdfPath}. Place the book PDFs locally and pass --pdf-dir pointing at them; they are never committed to this repo.`);
    }

    let chapterChunks = 0;
    for (let page = chapter.pdfPageStart; page <= chapter.pdfPageEnd; page += 1) {
      const printedPage = page - chapter.pageOffset;
      const pageText = extractPageText(pdfPath, page);
      const pageChunks = chunkPageText(pageText);
      let charCursor = 0;
      for (const chunkText of pageChunks) {
        const contentHash = createHash('sha256').update(chunkText).digest('hex');
        upsertSourceChunk({
          chapterId: chapter.chapterId,
          pdfPage: page,
          printedPage,
          contentHash,
          text: chunkText,
          charStart: charCursor,
          charEnd: charCursor + chunkText.length,
        });
        charCursor += chunkText.length;
        chapterChunks += 1;
      }
    }
    totalChunks += chapterChunks;
    console.log(`[ingest] ${chapter.chapterId} (${chapter.title}): ${chapterChunks} chunk(s) from pages ${chapter.pdfPageStart}-${chapter.pdfPageEnd}, now ${countChunksForChapter(chapter.chapterId)} total in DB`);
  }
  console.log(`[ingest] done: ${totalChunks} chunk(s) written across ${registry.length} chapter(s)`);
}

main().catch((err) => {
  console.error(`[ingest] failed: ${(err as Error).message}`);
  process.exit(1);
});
