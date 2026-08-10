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
  if (!tryAcquireRoomLock(roomId)) throw new RoomBusyError(roomId);
  try {
    return await fn();
  } finally {
    releaseRoomLock(roomId);
  }
}

/**
 * Non-blocking split of `withRoomLock`'s acquire/release for callers that must return control to
 * their caller (e.g. an HTTP response) before the locked work finishes — the lock still has to be
 * held for the full duration of that work, just not from inside a single awaited call. Pair every
 * `true` result with exactly one `releaseRoomLock` once the work settles (success or failure).
 */
export function tryAcquireRoomLock(roomId: string): boolean {
  if (busyRooms.has(roomId)) return false;
  busyRooms.add(roomId);
  return true;
}

export function releaseRoomLock(roomId: string): void {
  busyRooms.delete(roomId);
}
