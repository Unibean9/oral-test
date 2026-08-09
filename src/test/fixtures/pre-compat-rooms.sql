-- SQLite layout shipped before the versioned session compatibility migration.
-- Exercised by the v0->v1->v2 migration test in test/e2e.ts.
CREATE TABLE rooms (
  room_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  current_phase TEXT NOT NULL DEFAULT 'framing',
  title TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  trace_may_be_incomplete INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE turns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id TEXT NOT NULL,
  turn_index INTEGER NOT NULL,
  role TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(room_id, turn_index, role)
);

CREATE TABLE trace (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id TEXT NOT NULL,
  turn_index INTEGER NOT NULL,
  phase TEXT NOT NULL,
  technique TEXT,
  diagnosis TEXT,
  trace_entry TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(room_id, turn_index)
);
