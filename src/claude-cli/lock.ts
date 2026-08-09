const busyRooms = new Set<string>();

export class RoomBusyError extends Error {
  constructor(roomId: string) {
    super(`Room ${roomId} is busy processing another request`);
    this.name = 'RoomBusyError';
  }
}

/**
 * Per-room in-memory lock: no two requests may run a `claude -p --resume <same room>`
 * process concurrently, or they'd corrupt the on-disk Claude session or the SQLite trace.
 * Rejects immediately with RoomBusyError (mapped to HTTP 409 by the route) rather than
 * queuing — double-submits are rare enough for an internal tool that an explicit retry is
 * acceptable.
 */
// `roomId` here is the key callers pass in, which is always a session id (the on-disk
// `runtimes/room/<uuid>/` identifier) — not the `rm_`-prefixed parent Room id from the DB
// layer. Kept unrenamed because `room_busy` is a published API error code.
export async function withRoomLock<T>(roomId: string, fn: () => Promise<T>): Promise<T> {
  if (busyRooms.has(roomId)) {
    throw new RoomBusyError(roomId);
  }
  busyRooms.add(roomId);
  try {
    return await fn();
  } finally {
    busyRooms.delete(roomId);
  }
}
