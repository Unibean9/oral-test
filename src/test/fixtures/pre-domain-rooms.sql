-- v1 (post-baseline) shape: rooms IS the session, with engine_step, message_id, and turn_id
-- already present. Used to test the v1 -> v2 domain-split migration in isolation from the
-- v0 -> v1 baseline path (pre-compat-rooms.sql covers that leg).
CREATE TABLE rooms (
  room_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  current_phase TEXT NOT NULL DEFAULT 'framing',
  engine_step INTEGER NOT NULL DEFAULT 0,
  title TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  trace_may_be_incomplete INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE turns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id TEXT NOT NULL REFERENCES rooms(room_id),
  turn_index INTEGER NOT NULL,
  role TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  message_id TEXT,
  turn_id TEXT,
  UNIQUE(room_id, turn_index, role)
);

CREATE TABLE trace (
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

CREATE INDEX idx_turns_room_turn ON turns(room_id, turn_index);
CREATE INDEX idx_trace_room_turn ON trace(room_id, turn_index);
CREATE UNIQUE INDEX idx_turns_message_id ON turns(message_id) WHERE message_id IS NOT NULL;

CREATE TABLE turn_operations (
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
CREATE INDEX idx_turn_operations_room_status ON turn_operations(room_id, status);

INSERT INTO rooms (room_id, created_at, current_phase, engine_step, title, status, trace_may_be_incomplete)
VALUES ('11111111-1111-1111-1111-111111111111', '2026-01-01T00:00:00.000Z', 'diverging', 3, NULL, 'active', 0);

INSERT INTO turns (room_id, turn_index, role, text, created_at, message_id, turn_id) VALUES
  ('11111111-1111-1111-1111-111111111111', 1, 'user', 'group turn text', '2026-01-01T00:00:01.000Z', 'msg-user-1', 'turn-1'),
  ('11111111-1111-1111-1111-111111111111', 1, 'facilitator', 'facilitator reply', '2026-01-01T00:00:02.000Z', 'msg-agent-1', 'turn-1');

INSERT INTO trace (room_id, turn_index, phase, technique, diagnosis, trace_entry, created_at)
VALUES ('11111111-1111-1111-1111-111111111111', 1, 'framing', '5W1H', 'group had not yet named the real problem', 'Framed the problem as X', '2026-01-01T00:00:02.000Z');

INSERT INTO turn_operations (turn_id, room_id, client_turn_id, status, turn_index, user_message_id, assistant_message_id, final_seq, created_at, updated_at, completed_at)
VALUES ('turn-1', '11111111-1111-1111-1111-111111111111', 'client-1', 'completed', 1, 'msg-user-1', 'msg-agent-1', 3, '2026-01-01T00:00:01.000Z', '2026-01-01T00:00:02.000Z', '2026-01-01T00:00:02.000Z');

-- A second room with an out-of-range engine_step, added by the ad-hoc `ALTER TABLE ADD COLUMN`
-- bootstrap that carried no CHECK constraint. Exercises the pre-copy clamp in migration v2.
INSERT INTO rooms (room_id, created_at, current_phase, engine_step, title, status, trace_may_be_incomplete)
VALUES ('22222222-2222-2222-2222-222222222222', '2026-01-02T00:00:00.000Z', 'framing', -1, NULL, 'active', 0);
