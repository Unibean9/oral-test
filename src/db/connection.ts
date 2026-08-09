import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMigrations } from './migrate.js';
import { acquireSingleWriterLock } from './singleWriterLock.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Two levels up, not three: from `src/db/` (tsx) and from `out/db/` (compiled) that is the
// repo root's `data/`, which is what `.gitignore`'s `data/` rule covers. Three levels resolved
// to the repo's PARENT directory — a regression from 944a5e8, which flattened `backend/` into
// the repo root and left this path counting the removed level.
const DB_PATH = process.env.DB_PATH ?? path.resolve(__dirname, '../../data/rooms.db');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

// Must run before `new Database(...)` below: this module is what actually opens the DB and
// runs migrations (including create-copy-drop-rename table rebuilds), and it is reached via
// app.ts's route imports well before server.ts's own top-level code executes (ESM evaluates
// imports depth-first before a module's own body runs). Acquiring the lock in server.ts's
// module body was too late — a second process would already have run the full migration path
// before being refused. Refusing to boot here, before the DB is touched at all, is the fix.
try {
  acquireSingleWriterLock(DB_PATH);
} catch (err) {
  // No app/logger exists yet this early — this is the only touchpoint before the process must
  // exit, so a plain console.error plus process.exit is intentional here.
  console.error(`[db] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
// Guards the user_version read/write against a stale process still shutting down during a
// restart; without this, the loser of that race would hit SQLITE_BUSY instead of waiting.
db.pragma('busy_timeout = 5000');
// WAL defaults to synchronous=NORMAL, under which the most recently committed transactions can
// be lost on power loss or an OS crash. A brainstorm turn is unrepeatable spoken input, so the
// durability the storage contract promises is worth the extra fsync per commit.
db.pragma('synchronous = FULL');

runMigrations(db);

// Migrations run with foreign_keys OFF (required for the create-copy-drop-rename dance);
// only after they are done do we turn FK enforcement on for the rest of the process.
db.pragma('foreign_keys = ON');

export { DB_PATH };
