-- FROZEN v1 baseline. Do not edit. Schema changes go in migrate.ts.
CREATE TABLE IF NOT EXISTS rooms (
  room_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  current_phase TEXT NOT NULL DEFAULT 'framing',
  engine_step INTEGER NOT NULL DEFAULT 0 CHECK(engine_step BETWEEN 0 AND 7),
  title TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  trace_may_be_incomplete INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS turns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id TEXT NOT NULL REFERENCES rooms(room_id),
  turn_index INTEGER NOT NULL,
  role TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(room_id, turn_index, role)
);

CREATE TABLE IF NOT EXISTS trace (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id TEXT NOT NULL REFERENCES rooms(room_id),
  turn_index INTEGER NOT NULL,
  phase TEXT NOT NULL,
  technique TEXT,
  diagnosis TEXT,
  trace_entry TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(room_id, turn_index)
);

CREATE INDEX IF NOT EXISTS idx_turns_room_turn ON turns(room_id, turn_index);
CREATE INDEX IF NOT EXISTS idx_trace_room_turn ON trace(room_id, turn_index);

CREATE TABLE IF NOT EXISTS turn_operations (
  turn_id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(room_id),
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
  UNIQUE(room_id, client_turn_id)
);
CREATE INDEX IF NOT EXISTS idx_turn_operations_room_status ON turn_operations(room_id, status);
