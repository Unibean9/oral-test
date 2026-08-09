#!/usr/bin/env node
// `tsc` emits only JavaScript, so non-TS files that are read at runtime relative to their
// module (`src/db/schema.sql`, loaded by migrationV1) never reach `out/`. Without this step
// `npm run compile && npm start` throws ENOENT on any database that still needs migration v1
// — i.e. every fresh install — while `npm run dev` works fine because tsx resolves from src/.
import { copyFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Every runtime asset that lives under src/ and is read by path at runtime.
const ASSETS = ['db/schema.sql'];

for (const relative of ASSETS) {
  const from = path.join(repoRoot, 'src', relative);
  const to = path.join(repoRoot, 'out', relative);
  mkdirSync(path.dirname(to), { recursive: true });
  copyFileSync(from, to);
  console.log(`[copy-assets] src/${relative} -> out/${relative}`);
}
