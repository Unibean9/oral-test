#!/usr/bin/env node
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const registryPath = path.join(__dirname, 'demo-chapter-registry.json');
const dbPath = path.resolve(process.env.DB_PATH ?? path.join(rootDir, 'data', 'rooms.db'));
const manifestPath = path.join(path.dirname(dbPath), 'demo-seed-manifest.json');
const writeManifest = process.argv.includes('--write-manifest');

interface RegistryChapter {
  chapterId: string;
  sourceFile: string;
  pdfPageStart: number;
  pdfPageEnd: number;
}

interface SeedManifest {
  version: 1;
  registryHash: string;
  sourcePdfHashes: Record<string, string>;
}

function sha256File(filePath: string): string {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function currentManifest(chapters: RegistryChapter[]): SeedManifest {
  const sourceFiles = [...new Set(chapters.map((chapter) => chapter.sourceFile))].sort();
  const sourcePdfHashes: Record<string, string> = {};
  for (const sourceFile of sourceFiles) {
    const pdfPath = path.join(rootDir, 'assets', sourceFile);
    if (!fs.existsSync(pdfPath)) throw new Error(`source PDF not found: ${pdfPath}`);
    sourcePdfHashes[sourceFile] = sha256File(pdfPath);
  }
  return { version: 1, registryHash: sha256File(registryPath), sourcePdfHashes };
}

function manifestsMatch(actual: SeedManifest, expected: SeedManifest): boolean {
  return actual.version === expected.version
    && actual.registryHash === expected.registryHash
    && JSON.stringify(actual.sourcePdfHashes) === JSON.stringify(expected.sourcePdfHashes);
}

function main(): void {
  const { chapters } = JSON.parse(fs.readFileSync(registryPath, 'utf8')) as { chapters: RegistryChapter[] };
  const manifest = currentManifest(chapters);
  if (!fs.existsSync(dbPath)) throw new Error(`SQLite database not found: ${dbPath}`);

  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = db.prepare(
      'SELECT chapter_id, COUNT(*) AS count, MIN(pdf_page) AS first_page, MAX(pdf_page) AS last_page FROM source_chunks GROUP BY chapter_id',
    ).all() as Array<{ chapter_id: string; count: number; first_page: number; last_page: number }>;
    const byChapter = new Map(rows.map((row) => [row.chapter_id, row]));
    for (const chapter of chapters) {
      const row = byChapter.get(chapter.chapterId);
      if (!row || row.count < 1) throw new Error(`missing source chunks for ${chapter.chapterId}`);
      if (row.first_page < chapter.pdfPageStart || row.last_page > chapter.pdfPageEnd) {
        throw new Error(`source chunks for ${chapter.chapterId} are outside registry pages ${chapter.pdfPageStart}-${chapter.pdfPageEnd}`);
      }
    }
  } finally {
    db.close();
  }

  if (writeManifest) {
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  } else {
    if (!fs.existsSync(manifestPath)) throw new Error(`seed manifest not found: ${manifestPath}; run task init`);
    const saved = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as SeedManifest;
    if (!manifestsMatch(saved, manifest)) {
      throw new Error('seed manifest does not match the current demo PDFs or chapter registry; run task seed');
    }
  }

  console.log(`[seed] verified ${chapters.length} demo chapters against ${path.basename(manifestPath)}`);
}

try {
  main();
} catch (err) {
  console.error(`[seed] verification failed: ${(err as Error).message}`);
  process.exit(1);
}
