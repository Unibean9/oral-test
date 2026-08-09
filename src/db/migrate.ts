import type Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { v4 as uuidv4 } from 'uuid';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Snapshots the live DB to `<dbfile>.pre-v{N}.bak` before a non-additive migration
 * (rename/rebuild) runs; throws before any DDL executes if the snapshot itself fails, so the
 * process fails safe instead of mutating the only copy with no recovery path.
 *
 * Uses `VACUUM INTO` rather than `copyFileSync`: a raw file copy of a live WAL database takes no
 * read lock, so the main file and its -wal/-shm sidecars can be read at three different instants
 * and capture a torn state. `VACUUM INTO` takes a consistent snapshot with the WAL folded in.
 */
function backupBeforeMigration(db: Database.Database, targetVersion: number): void {
  const dbPath = db.name;
  // An in-memory or throwaway test DB (":memory:", or a path that does not exist yet) has
  // nothing to back up.
  if (!dbPath || dbPath === ':memory:' || !fs.existsSync(dbPath)) return;
  const backupPath = `${dbPath}.pre-v${targetVersion}.bak`;
  try {
    // VACUUM INTO refuses to overwrite, so clear any snapshot left by an earlier failed run.
    fs.rmSync(backupPath, { force: true });
    for (const stale of [`${backupPath}-wal`, `${backupPath}-shm`]) fs.rmSync(stale, { force: true });
    db.prepare('VACUUM INTO ?').run(backupPath);
  } catch (err) {
    throw new Error(
      `Pre-migration backup to ${backupPath} failed; aborting migration v${targetVersion} before any DDL ran: ${(err as Error).message}`,
    );
  }
}

function assertNoFkViolations(db: Database.Database): void {
  const violations = db.pragma('foreign_key_check') as Array<{ table?: string }>;
  if (violations.length > 0) {
    // Name the affected tables, not the rows: the full dump embeds row ids (and, via the
    // parent column, session content) into an exception that ends up in logs.
    const tables = [...new Set(violations.map((v) => v.table ?? 'unknown'))].join(', ');
    throw new Error(`Migration aborted: foreign_key_check found ${violations.length} violation(s) in table(s): ${tables}`);
  }
}

function migrationV1(db: Database.Database): void {
  const schemaPath = path.resolve(__dirname, 'schema.sql');
  if (!fs.existsSync(schemaPath)) {
    throw new Error(
      `Baseline schema not found at ${schemaPath}. In a compiled build this file is copied by ` +
        `scripts/copy-assets.mjs — run \`npm run compile\` rather than \`tsc\` alone.`,
    );
  }
  db.exec(fs.readFileSync(schemaPath, 'utf8'));
  const turnColumns = db.prepare('PRAGMA table_info(turns)').all() as Array<{ name: string }>;
  if (!turnColumns.some((column) => column.name === 'message_id')) db.exec('ALTER TABLE turns ADD COLUMN message_id TEXT');
  if (!turnColumns.some((column) => column.name === 'turn_id')) db.exec('ALTER TABLE turns ADD COLUMN turn_id TEXT');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_turns_message_id ON turns(message_id) WHERE message_id IS NOT NULL');
  const roomColumns = db.prepare('PRAGMA table_info(rooms)').all() as Array<{ name: string }>;
  if (!roomColumns.some((column) => column.name === 'engine_step')) db.exec('ALTER TABLE rooms ADD COLUMN engine_step INTEGER NOT NULL DEFAULT 0');
}

function migrationV2(db: Database.Database): void {
  db.exec(`
    CREATE TABLE teachers (
      teacher_id TEXT PRIMARY KEY,
      code       TEXT NOT NULL UNIQUE,
      name       TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  db.exec(`
    CREATE TABLE rooms_new (
      room_id          TEXT PRIMARY KEY,
      name             TEXT NOT NULL,
      owner_teacher_id TEXT NOT NULL REFERENCES teachers(teacher_id),
      created_at       TEXT NOT NULL
    );
  `);
  db.exec(`
    CREATE TABLE sessions (
      session_id             TEXT PRIMARY KEY,
      room_id                TEXT NOT NULL REFERENCES rooms(room_id),
      name                   TEXT NOT NULL,
      created_by_teacher_id  TEXT NOT NULL REFERENCES teachers(teacher_id),
      created_at             TEXT NOT NULL,
      current_phase          TEXT NOT NULL DEFAULT 'framing',
      engine_step            INTEGER NOT NULL DEFAULT 0 CHECK(engine_step BETWEEN 0 AND 7),
      status                 TEXT NOT NULL DEFAULT 'active',
      trace_may_be_incomplete INTEGER NOT NULL DEFAULT 0
    );
  `);

  const legacyCount = (db.prepare('SELECT COUNT(*) AS n FROM rooms').get() as { n: number }).n;
  let legacyTeacherId: string | null = null;
  let legacyRoomId: string | null = null;
  if (legacyCount > 0) {
    legacyTeacherId = uuidv4();
    legacyRoomId = `rm_${uuidv4()}`;
    const now = new Date().toISOString();
    // '__legacy__' is deliberately not a valid human-entered code shape (real codes are short
    // alphanumeric like 'GV01'), so it can never collide with a real teacher's own code.
    db.prepare('INSERT INTO teachers (teacher_id, code, name, created_at) VALUES (?, ?, ?, ?)').run(legacyTeacherId, '__legacy__', 'Unassigned', now);
    db.prepare('INSERT INTO rooms_new (room_id, name, owner_teacher_id, created_at) VALUES (?, ?, ?, ?)').run(legacyRoomId, 'Legacy', legacyTeacherId, now);
  }

  // The rebuilt `sessions` table CHECKs engine_step BETWEEN 0 AND 7, but the ad-hoc bootstrap
  // added that column to older DBs with no such CHECK, so an out-of-range legacy value would
  // abort this transaction when the copy below hits it. Clamp instead of failing outright —
  // this is legacy data hygiene, not something worth blocking a migration over — but log a
  // clear, actionable warning naming the offending session ids.
  const outOfRange = db.prepare('SELECT room_id, engine_step FROM rooms WHERE engine_step < 0 OR engine_step > 7').all() as Array<{ room_id: string; engine_step: number }>;
  if (outOfRange.length > 0) {
    console.warn(
      `[migrate] v2: clamping out-of-range engine_step for session(s) ${outOfRange.map((r) => `${r.room_id} (${r.engine_step})`).join(', ')} into 0..7`,
    );
  }

  if (legacyCount > 0) {
    // Carry the legacy `rooms.title` into `sessions.name` rather than dropping it: the v1
    // schema's only human-readable label for a room is `title`, and the table is dropped at the
    // end of this migration, so anything not copied here is recoverable only from the
    // pre-v2 snapshot. Falls back to room_id when the title is NULL or blank, which is what
    // every untitled legacy row gets.
    db.prepare(
      `INSERT INTO sessions (session_id, room_id, name, created_by_teacher_id, created_at, current_phase, engine_step, status, trace_may_be_incomplete)
       SELECT room_id, ?, COALESCE(NULLIF(TRIM(title), ''), room_id), ?, created_at, current_phase, MIN(MAX(engine_step, 0), 7), status, trace_may_be_incomplete FROM rooms`,
    ).run(legacyRoomId, legacyTeacherId);
  }

  db.exec(`
    CREATE TABLE turns_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES sessions(session_id),
      turn_index INTEGER NOT NULL,
      role TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at TEXT NOT NULL,
      message_id TEXT,
      turn_id TEXT,
      UNIQUE(session_id, turn_index, role)
    );
  `);
  db.exec(`
    CREATE TABLE trace_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES sessions(session_id),
      turn_index INTEGER NOT NULL,
      phase TEXT NOT NULL,
      technique TEXT,
      diagnosis TEXT,
      trace_entry TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(session_id, turn_index)
    );
  `);
  db.exec(`
    CREATE TABLE turn_operations_new (
      turn_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(session_id),
      client_turn_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('accepted','processing','completed','failed','interrupted')),
      turn_index INTEGER NOT NULL,
      user_message_id TEXT NOT NULL,
      assistant_message_id TEXT,
      error_code TEXT,
      final_seq INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT,
      UNIQUE(session_id, client_turn_id)
    );
  `);

  db.exec(`
    INSERT INTO turns_new (id, session_id, turn_index, role, text, created_at, message_id, turn_id)
    SELECT id, room_id, turn_index, role, text, created_at, message_id, turn_id FROM turns
  `);
  db.exec(`
    INSERT INTO trace_new (id, session_id, turn_index, phase, technique, diagnosis, trace_entry, created_at)
    SELECT id, room_id, turn_index, phase, technique, diagnosis, trace_entry, created_at FROM trace
  `);
  db.exec(`
    INSERT INTO turn_operations_new (turn_id, session_id, client_turn_id, status, turn_index, user_message_id, assistant_message_id, error_code, final_seq, created_at, updated_at, completed_at)
    SELECT turn_id, room_id, client_turn_id, status, turn_index, user_message_id, assistant_message_id, error_code, final_seq, created_at, updated_at, completed_at FROM turn_operations
  `);

  db.exec('DROP TABLE turn_operations');
  db.exec('DROP TABLE trace');
  db.exec('DROP TABLE turns');
  db.exec('DROP TABLE rooms');

  // foreign_keys is OFF for this whole transaction, so this RENAME leaves other tables' FK
  // clauses untouched — which is correct, since they already name the final table names.
  db.exec('ALTER TABLE rooms_new RENAME TO rooms');
  db.exec('ALTER TABLE turns_new RENAME TO turns');
  db.exec('ALTER TABLE trace_new RENAME TO trace');
  db.exec('ALTER TABLE turn_operations_new RENAME TO turn_operations');

  db.exec('CREATE INDEX idx_turns_session_turn ON turns(session_id, turn_index)');
  db.exec('CREATE INDEX idx_trace_session_turn ON trace(session_id, turn_index)');
  db.exec('CREATE INDEX idx_turn_operations_session_status ON turn_operations(session_id, status)');
  db.exec('CREATE UNIQUE INDEX idx_turns_message_id ON turns(message_id) WHERE message_id IS NOT NULL');
}

function migrationV3(db: Database.Database): void {
  db.exec(`
    CREATE TABLE cloud_sync_queue (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id      TEXT NOT NULL REFERENCES sessions(session_id),
      kind            TEXT NOT NULL CHECK(kind IN ('trace','metadata','report','landing','pitch')),
      status          TEXT NOT NULL CHECK(status IN ('pending','syncing','done','failed')),
      dirty           INTEGER NOT NULL DEFAULT 0,
      attempts        INTEGER NOT NULL DEFAULT 0,
      last_error      TEXT,
      next_attempt_at TEXT NOT NULL,
      created_at      TEXT NOT NULL,
      updated_at      TEXT NOT NULL,
      UNIQUE(session_id, kind)
    );
  `);
  db.exec('CREATE INDEX idx_cloud_sync_queue_due ON cloud_sync_queue(status, next_attempt_at)');
  // Additive-only: constant defaults mean no table rebuild is needed, unlike v2.
  db.exec('ALTER TABLE sessions ADD COLUMN audio_failure_count INTEGER NOT NULL DEFAULT 0');
  db.exec('ALTER TABLE sessions ADD COLUMN artifact_errors TEXT');
  db.exec('ALTER TABLE sessions ADD COLUMN wrapped_at TEXT');
}

function migrationV4(db: Database.Database): void {
  db.exec(`
    CREATE TABLE cloud_sync_queue_new (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id      TEXT NOT NULL REFERENCES sessions(session_id),
      kind            TEXT NOT NULL CHECK(kind IN ('trace','metadata','prd','landing','pitch')),
      status          TEXT NOT NULL CHECK(status IN ('pending','syncing','done','failed')),
      dirty           INTEGER NOT NULL DEFAULT 0,
      attempts        INTEGER NOT NULL DEFAULT 0,
      last_error      TEXT,
      next_attempt_at TEXT NOT NULL,
      created_at      TEXT NOT NULL,
      updated_at      TEXT NOT NULL,
      UNIQUE(session_id, kind)
    );
  `);
  db.exec(`
    INSERT INTO cloud_sync_queue_new (id, session_id, kind, status, dirty, attempts, last_error, next_attempt_at, created_at, updated_at)
    SELECT id, session_id, CASE WHEN kind = 'report' THEN 'prd' ELSE kind END, status, dirty, attempts, last_error, next_attempt_at, created_at, updated_at FROM cloud_sync_queue
  `);
  db.exec('DROP TABLE cloud_sync_queue');
  db.exec('ALTER TABLE cloud_sync_queue_new RENAME TO cloud_sync_queue');
  db.exec('CREATE INDEX idx_cloud_sync_queue_due ON cloud_sync_queue(status, next_attempt_at)');
}

/**
 * Adds `owner_instance_id`/`owner_pid`/`lease_expires_at`. These columns are now dormant —
 * `singleWriterLock.ts` replaced the lease protocol that wrote them — kept only because dropping
 * them needs a create-copy-drop-rename, not because anything still reads them. See
 * `db/sessions.ts` for the current write path.
 */
function migrationV5(db: Database.Database): void {
  db.exec('ALTER TABLE turn_operations ADD COLUMN owner_instance_id TEXT');
  db.exec('ALTER TABLE turn_operations ADD COLUMN owner_pid INTEGER');
  db.exec('ALTER TABLE turn_operations ADD COLUMN lease_expires_at TEXT');
}

/** Additive: per-session voice, fixed at session creation (a room can hold multiple sessions
 * across separate class periods, and each may pick a different voice). Existing rows take the
 * default preset. Constant default => no table rebuild, same shape as migrationV3's
 * audio_failure_count. */
function migrationV6(db: Database.Database): void {
  db.exec("ALTER TABLE sessions ADD COLUMN voice_id TEXT NOT NULL DEFAULT 'vi-female-01'");
}

const BLOOM_LEVELS: Array<{ bloom_level: string; rank: number }> = [
  { bloom_level: 'remember', rank: 1 },
  { bloom_level: 'understand', rank: 2 },
  { bloom_level: 'apply', rank: 3 },
  { bloom_level: 'analyze', rank: 4 },
  { bloom_level: 'evaluate', rank: 5 },
  { bloom_level: 'create', rank: 6 },
];

// Demo-scoped chapter registry: mirrors scripts/demo-chapter-registry.json (Phase 3's source of
// truth for ingestion). Seeded here too so blueprint_slots below can reference real chapter_ids
// without waiting on a PDF ingestion run — the ingestion script only ever fills source_chunks for
// chapters this migration already created (`INSERT OR IGNORE`, chapter_id is the shared key).
const DEMO_CHAPTERS: Array<{
  chapter_id: string; course_id: string; chapter_no: number; title: string; source_file: string;
  pdf_page_start: number; pdf_page_end: number; page_offset: number;
}> = [
  { chapter_id: 'SWR-1', course_id: 'SWR', chapter_no: 1, title: 'The essential software requirement', source_file: 'Software_Requirements_3rd_Edition.pdf', pdf_page_start: 36, pdf_page_end: 57, page_offset: 33 },
  { chapter_id: 'SWR-2', course_id: 'SWR', chapter_no: 2, title: "Requirements from the customer's perspective", source_file: 'Software_Requirements_3rd_Edition.pdf', pdf_page_start: 58, pdf_page_end: 75, page_offset: 33 },
  { chapter_id: 'SWR-3', course_id: 'SWR', chapter_no: 3, title: 'Good practices for requirements engineering', source_file: 'Software_Requirements_3rd_Edition.pdf', pdf_page_start: 76, pdf_page_end: 93, page_offset: 33 },
  { chapter_id: 'SWT-1', course_id: 'SWT', chapter_no: 1, title: 'Fundamentals of testing', source_file: 'FOUNDATIONS_OF_SOFTWARE_TESTING_ISTQB_CE.pdf', pdf_page_start: 4, pdf_page_end: 37, page_offset: 3 },
  { chapter_id: 'SWT-3', course_id: 'SWT', chapter_no: 3, title: 'Static techniques', source_file: 'FOUNDATIONS_OF_SOFTWARE_TESTING_ISTQB_CE.pdf', pdf_page_start: 60, pdf_page_end: 79, page_offset: 3 },
];

const SWR_CLOS: Array<{ clo_no: number; description: string }> = [
  { clo_no: 1, description: 'Develop a good understanding of principles and techniques for requirement engineering (RE) regarding requirement inception, requirement development (elicitation, analysis, specification, validation) and requirement management; understand main characteristics of specific projects' },
  { clo_no: 2, description: 'Identify the appropriate requirements elicitation techniques to identify requirements' },
  { clo_no: 3, description: 'Utilize various requirements validation techniques to critically evaluate their requirements to identify defects' },
  { clo_no: 4, description: 'Analysis of system requirements and the production of system specifications' },
  { clo_no: 5, description: 'Create models of requirements using a variety of notations and techniques, including domain and usage models' },
  { clo_no: 6, description: 'Design and plan software solutions to problems using an object-oriented strategy' },
  { clo_no: 7, description: 'Prepare and deliver coherent and structured verbal and written technical reports' },
  { clo_no: 8, description: 'Understand how to reduce risks by prototyping' },
  { clo_no: 9, description: 'Utilize the tactic of requirements management regarding changing, tracing and improving requirements' },
];

const SWT_CLOS: Array<{ clo_no: number; description: string }> = [
  { clo_no: 1, description: 'Know definitions, concepts and terminologies about Software Testing, using AI to explore testing principles and real-world testing scenarios through effective prompts' },
  { clo_no: 2, description: 'Understand the software testing process. Distinguish between levels of testing (unit, integration, system, acceptance) and types of testing (functional, non-functional) applied to a specific group project' },
  { clo_no: 3, description: 'Use static testing techniques to detect errors through a review process, using AI to review documents for defects (ambiguity, inconsistency) and analyze static code for errors (code smells, bug patterns)' },
  { clo_no: 4, description: 'Use dynamic testing techniques like black-box, white-box, and experience-based testing to design and execute test cases, and determine test coverage' },
  { clo_no: 5, description: 'Develop a comprehensive test plan for an AI-enabled project, clearly defining its scope, goals, resources, and testing schedule' },
  { clo_no: 6, description: 'Analyze and prioritize risks to focus testing efforts effectively. Understand and apply bug logging, bug reporting, and test reporting practices' },
  { clo_no: 7, description: 'Classify and select appropriate testing tools, evaluate the benefits and risks of test automation, and choose an automation tool for testing functionalities in the team project' },
  { clo_no: 8, description: 'Understand and apply Agile testing methods' },
  { clo_no: 9, description: 'Utilize AI tools to support learning and exercises related to the course' },
  { clo_no: 10, description: 'Demonstrate presentation skills and effective teamwork' },
];

// Only slots for CLOs groundable in the 5 demo chapters' PDF text (see plan.md's exclusion list:
// SWT CLO7/9/10 and SWR CLO6/7/9 are tooling/teamwork/presentation outcomes, not answerable from
// source-chunk text alone, so no blueprint slot references them).
const DEMO_BLUEPRINT_SLOTS: Array<{
  blueprint_id: string; chapter_id: string; clo_no: number; bloom_level: string; question_count: number;
}> = [
  { blueprint_id: 'bp_swr_demo_v1', chapter_id: 'SWR-1', clo_no: 1, bloom_level: 'remember', question_count: 2 },
  { blueprint_id: 'bp_swr_demo_v1', chapter_id: 'SWR-1', clo_no: 1, bloom_level: 'understand', question_count: 3 },
  { blueprint_id: 'bp_swr_demo_v1', chapter_id: 'SWR-2', clo_no: 2, bloom_level: 'understand', question_count: 3 },
  { blueprint_id: 'bp_swr_demo_v1', chapter_id: 'SWR-2', clo_no: 2, bloom_level: 'apply', question_count: 2 },
  { blueprint_id: 'bp_swr_demo_v1', chapter_id: 'SWR-3', clo_no: 3, bloom_level: 'apply', question_count: 3 },
  { blueprint_id: 'bp_swr_demo_v1', chapter_id: 'SWR-3', clo_no: 3, bloom_level: 'analyze', question_count: 2 },
  { blueprint_id: 'bp_swt_demo_v1', chapter_id: 'SWT-1', clo_no: 1, bloom_level: 'remember', question_count: 3 },
  { blueprint_id: 'bp_swt_demo_v1', chapter_id: 'SWT-1', clo_no: 1, bloom_level: 'understand', question_count: 2 },
  { blueprint_id: 'bp_swt_demo_v1', chapter_id: 'SWT-1', clo_no: 2, bloom_level: 'understand', question_count: 2 },
  { blueprint_id: 'bp_swt_demo_v1', chapter_id: 'SWT-3', clo_no: 3, bloom_level: 'apply', question_count: 3 },
  { blueprint_id: 'bp_swt_demo_v1', chapter_id: 'SWT-3', clo_no: 3, bloom_level: 'analyze', question_count: 2 },
];

/**
 * Oral-test domain: Course -> Chapter -> CLO -> Bloom level taxonomy, seeded blueprints (static
 * demo data, no draft/approve workflow — see plan.md), sessions, questions, turns, rubric,
 * reports. Additive only: no existing table (rooms/turns/trace/turn_operations/teachers) is
 * touched. `blueprints` deliberately has no teacher_id/status column — shared seed data, not a
 * per-teacher draft artifact.
 */
function migrationV7(db: Database.Database): void {
  db.exec(`
    CREATE TABLE courses (
      course_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE chapters (
      chapter_id TEXT PRIMARY KEY,
      course_id TEXT NOT NULL REFERENCES courses(course_id),
      chapter_no INTEGER NOT NULL,
      title TEXT NOT NULL,
      source_file TEXT NOT NULL,
      pdf_page_start INTEGER NOT NULL,
      pdf_page_end INTEGER NOT NULL,
      printed_page_start INTEGER,
      printed_page_end INTEGER,
      page_offset INTEGER NOT NULL,
      is_demo_included INTEGER NOT NULL DEFAULT 1,
      UNIQUE(course_id, chapter_no)
    );
    CREATE INDEX idx_chapters_course ON chapters(course_id);

    CREATE TABLE clos (
      clo_id TEXT PRIMARY KEY,
      course_id TEXT NOT NULL REFERENCES courses(course_id),
      clo_no INTEGER NOT NULL,
      description TEXT NOT NULL,
      UNIQUE(course_id, clo_no)
    );
    CREATE INDEX idx_clos_course ON clos(course_id);

    CREATE TABLE bloom_levels (
      bloom_level TEXT PRIMARY KEY,
      rank INTEGER NOT NULL UNIQUE
    );

    CREATE TABLE source_chunks (
      chunk_id TEXT PRIMARY KEY,
      chapter_id TEXT NOT NULL REFERENCES chapters(chapter_id),
      pdf_page INTEGER NOT NULL,
      printed_page INTEGER,
      content_hash TEXT NOT NULL,
      text TEXT NOT NULL,
      char_start INTEGER,
      char_end INTEGER,
      created_at TEXT NOT NULL
    );
    CREATE INDEX idx_source_chunks_chapter ON source_chunks(chapter_id);
    CREATE UNIQUE INDEX idx_source_chunks_chapter_hash ON source_chunks(chapter_id, content_hash);

    CREATE TABLE blueprints (
      blueprint_id TEXT PRIMARY KEY,
      course_id TEXT NOT NULL REFERENCES courses(course_id),
      name TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE blueprint_slots (
      slot_id TEXT PRIMARY KEY,
      blueprint_id TEXT NOT NULL REFERENCES blueprints(blueprint_id),
      chapter_id TEXT NOT NULL REFERENCES chapters(chapter_id),
      clo_id TEXT NOT NULL REFERENCES clos(clo_id),
      bloom_level TEXT NOT NULL REFERENCES bloom_levels(bloom_level),
      question_count INTEGER NOT NULL CHECK(question_count > 0),
      difficulty_hint REAL,
      UNIQUE(blueprint_id, chapter_id, clo_id, bloom_level)
    );
    CREATE INDEX idx_blueprint_slots_blueprint ON blueprint_slots(blueprint_id);

    CREATE TABLE assessment_sessions (
      session_id TEXT PRIMARY KEY,
      blueprint_id TEXT NOT NULL REFERENCES blueprints(blueprint_id),
      teacher_id TEXT NOT NULL REFERENCES teachers(teacher_id),
      student_code TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('in_progress','completed','reviewed','approved')) DEFAULT 'in_progress',
      started_at TEXT NOT NULL,
      ended_at TEXT,
      expires_at TEXT NOT NULL
    );
    CREATE INDEX idx_assessment_sessions_teacher ON assessment_sessions(teacher_id);
    CREATE INDEX idx_assessment_sessions_expires ON assessment_sessions(expires_at);

    CREATE TABLE questions (
      question_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES assessment_sessions(session_id),
      slot_id TEXT NOT NULL REFERENCES blueprint_slots(slot_id),
      chapter_id TEXT NOT NULL REFERENCES chapters(chapter_id),
      clo_id TEXT NOT NULL REFERENCES clos(clo_id),
      bloom_level TEXT NOT NULL REFERENCES bloom_levels(bloom_level),
      source_chunk_ids TEXT NOT NULL,
      question_text TEXT NOT NULL,
      prompt_version TEXT NOT NULL,
      model_version TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX idx_questions_session ON questions(session_id);

    CREATE TABLE oral_turns (
      turn_id TEXT PRIMARY KEY,
      question_id TEXT NOT NULL REFERENCES questions(question_id),
      input_mode TEXT NOT NULL CHECK(input_mode IN ('stt','typed')),
      text TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX idx_oral_turns_question ON oral_turns(question_id);

    CREATE TABLE rubric_items (
      item_id TEXT PRIMARY KEY,
      question_id TEXT NOT NULL REFERENCES questions(question_id),
      ai_suggested_level TEXT,
      lecturer_override_level TEXT,
      evidence_turn_ids TEXT NOT NULL,
      comment TEXT,
      approver TEXT REFERENCES teachers(teacher_id),
      approved_at TEXT
    );
    CREATE INDEX idx_rubric_items_question ON rubric_items(question_id);

    CREATE TABLE reports (
      report_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL UNIQUE REFERENCES assessment_sessions(session_id),
      status TEXT NOT NULL CHECK(status IN ('draft','approved')) DEFAULT 'draft',
      approved_by TEXT REFERENCES teachers(teacher_id),
      approved_at TEXT,
      created_at TEXT NOT NULL
    );
  `);

  const now = new Date().toISOString();

  const insertBloom = db.prepare('INSERT OR IGNORE INTO bloom_levels (bloom_level, rank) VALUES (?, ?)');
  for (const level of BLOOM_LEVELS) insertBloom.run(level.bloom_level, level.rank);

  const insertCourse = db.prepare('INSERT OR IGNORE INTO courses (course_id, name, created_at) VALUES (?, ?, ?)');
  insertCourse.run('SWR', 'Software Requirements', now);
  insertCourse.run('SWT', 'Foundations of Software Testing', now);

  const insertChapter = db.prepare(
    `INSERT OR IGNORE INTO chapters
     (chapter_id, course_id, chapter_no, title, source_file, pdf_page_start, pdf_page_end, page_offset, is_demo_included)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
  );
  for (const chapter of DEMO_CHAPTERS) {
    insertChapter.run(
      chapter.chapter_id, chapter.course_id, chapter.chapter_no, chapter.title,
      chapter.source_file, chapter.pdf_page_start, chapter.pdf_page_end, chapter.page_offset,
    );
  }

  const insertClo = db.prepare('INSERT OR IGNORE INTO clos (clo_id, course_id, clo_no, description) VALUES (?, ?, ?, ?)');
  for (const clo of SWR_CLOS) insertClo.run(`SWR-CLO${clo.clo_no}`, 'SWR', clo.clo_no, clo.description);
  for (const clo of SWT_CLOS) insertClo.run(`SWT-CLO${clo.clo_no}`, 'SWT', clo.clo_no, clo.description);

  const insertBlueprint = db.prepare('INSERT OR IGNORE INTO blueprints (blueprint_id, course_id, name, created_at) VALUES (?, ?, ?, ?)');
  insertBlueprint.run('bp_swr_demo_v1', 'SWR', 'SWR Demo Blueprint v1', now);
  insertBlueprint.run('bp_swt_demo_v1', 'SWT', 'SWT Demo Blueprint v1', now);

  const insertSlot = db.prepare(
    `INSERT OR IGNORE INTO blueprint_slots (slot_id, blueprint_id, chapter_id, clo_id, bloom_level, question_count)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  for (const slot of DEMO_BLUEPRINT_SLOTS) {
    const courseId = slot.blueprint_id === 'bp_swr_demo_v1' ? 'SWR' : 'SWT';
    const cloId = `${courseId}-CLO${slot.clo_no}`;
    const slotId = `${slot.blueprint_id}__${slot.chapter_id}__${cloId}__${slot.bloom_level}`;
    insertSlot.run(slotId, slot.blueprint_id, slot.chapter_id, cloId, slot.bloom_level, slot.question_count);
  }
}

/**
 * Adds `password_hash`, confirmed absent from `teachers` today (only `teacher_id`/`code`/`name`/
 * `created_at` exist — `code` alone was identity, no secret). Nullable: legacy teachers rows
 * (including the `__legacy__` bootstrap row) have no password and cannot log in via the new JWT
 * flow until they register one — additive, no rebuild needed.
 */
function migrationV8(db: Database.Database): void {
  db.exec('ALTER TABLE teachers ADD COLUMN password_hash TEXT');
}

const MIGRATIONS: Array<{ version: number; up: (db: Database.Database) => void; nonAdditive?: boolean }> = [
  { version: 1, up: migrationV1 },
  { version: 2, up: migrationV2, nonAdditive: true },
  { version: 3, up: migrationV3 },
  { version: 4, up: migrationV4, nonAdditive: true },
  { version: 5, up: migrationV5 },
  { version: 6, up: migrationV6 },
  { version: 7, up: migrationV7 },
  { version: 8, up: migrationV8 },
];

export function runMigrations(db: Database.Database): void {
  const current = db.pragma('user_version', { simple: true }) as number;
  if (MIGRATIONS.length === 0) throw new Error('No migrations are registered; refusing to run against an unknown schema');
  const latest = MIGRATIONS[MIGRATIONS.length - 1].version;
  // Only the "DB is behind" direction was ever guarded. "DB is ahead" is the direction that
  // corrupts, and it is not hypothetical here: `npm run dev` under tsx and `node out/server.js`
  // share the default DB_PATH. Migration v4 narrowed the turn CHECK constraint from 'report' to
  // 'prd', so an older binary's enqueue() hits a CHECK failure that enqueueCloudSync deliberately
  // swallows — cloud sync just stops, with a console line nobody reads. Throwing here surfaces at
  // db/connection.ts's module load, so the process never binds a port: a startup failure is
  // strictly better than a silently half-working server.
  if (current > latest) {
    throw new Error(
      `Database schema is v${current} but this build only knows up to v${latest} (${db.name}). `
      + 'A newer build has already migrated this database. Refusing to start: an older binary '
      + 'writing against a newer schema fails CHECK constraints that callers silently swallow, '
      + 'so the damage is invisible. Update this build, or point DB_PATH at a different file.',
    );
  }
  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue;
    if (migration.nonAdditive) backupBeforeMigration(db, migration.version);
    db.pragma('foreign_keys = OFF');
    // `.immediate()`, not the default deferred form. A deferred BEGIN acquires only a read
    // snapshot, so the user_version re-read below would not be protected by a write lock: a
    // second process committing in between makes this transaction fail with
    // SQLITE_BUSY_SNAPSHOT — which busy_timeout does NOT retry — instead of no-opping as the
    // comment promises. BEGIN IMMEDIATE takes the write lock up front, so the loser of the
    // race waits out busy_timeout and then observes the winner's user_version.
    db.transaction(() => {
      // Re-reading user_version inside the transaction (not just once before the loop) means a
      // second process racing to migrate the same DB no-ops instead of re-running a destructive
      // rename against tables the first process already renamed.
      const v = db.pragma('user_version', { simple: true }) as number;
      if (v >= migration.version) return;
      migration.up(db);
      assertNoFkViolations(db);
      // PRAGMA values cannot be bound, so this is the one interpolated statement in the DB
      // layer. Assert the shape rather than trusting the literal table above to stay literal.
      if (!Number.isInteger(migration.version)) throw new Error(`Refusing to set a non-integer user_version: ${migration.version}`);
      db.pragma(`user_version = ${migration.version}`);
    }).immediate();
    db.pragma('foreign_keys = ON');
    console.log(`[migrate] applied v${migration.version}`);
  }
}
