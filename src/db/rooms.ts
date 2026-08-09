import { v4 as uuidv4 } from 'uuid';
import { db } from './connection.js';
import { ROOM_ID_PREFIX } from '../brainstorm/contracts.js';

export interface RoomRow {
  room_id: string;
  name: string;
  owner_teacher_id: string;
  created_at: string;
}

export interface RoomWithOwner extends RoomRow {
  owner_name: string;
}

export interface SessionListItem {
  session_id: string;
  name: string;
  status: string;
  current_phase: string;
  created_at: string;
}

const insertRoom = db.prepare('INSERT INTO rooms (room_id, name, owner_teacher_id, created_at) VALUES (?, ?, ?, ?)');
export function createRoom(params: { name: string; ownerTeacherId: string }): RoomRow {
  const roomId = `${ROOM_ID_PREFIX}${uuidv4()}`;
  const createdAt = new Date().toISOString();
  insertRoom.run(roomId, params.name, params.ownerTeacherId, createdAt);
  return { room_id: roomId, name: params.name, owner_teacher_id: params.ownerTeacherId, created_at: createdAt };
}

const selectRoomById = db.prepare('SELECT * FROM rooms WHERE room_id = ?');
export function getRoom(roomId: string): RoomRow | undefined {
  return selectRoomById.get(roomId) as RoomRow | undefined;
}

// Excludes the bootstrap 'Legacy' room created by db/migrate.ts's migrationV2, matched by owner
// being the system teacher (code = '__legacy__') rather than the mutable room name — more
// robust than a name match.
const selectRoomsExceptLegacy = db.prepare(`
  SELECT rooms.*, teachers.name AS owner_name
  FROM rooms
  JOIN teachers ON teachers.teacher_id = rooms.owner_teacher_id
  WHERE teachers.code != '__legacy__'
  ORDER BY rooms.created_at DESC
`);
export function listRooms(): RoomWithOwner[] {
  return selectRoomsExceptLegacy.all() as RoomWithOwner[];
}

const selectSessionsInRoom = db.prepare(`
  SELECT session_id, name, status, current_phase, created_at FROM sessions WHERE room_id = ? ORDER BY created_at DESC
`);
export function listSessionsInRoom(roomId: string): SessionListItem[] {
  return selectSessionsInRoom.all(roomId) as SessionListItem[];
}
