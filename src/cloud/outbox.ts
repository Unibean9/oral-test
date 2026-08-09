import fsp from 'node:fs/promises';
import type { CloudSyncQueueRow } from '../db/cloudSyncQueue.js';
import { claimDue, markDone, markRetry, MAX_ATTEMPTS } from '../db/cloudSyncQueue.js';
import { getSession } from '../db/sessions.js';
import { getRoom } from '../db/rooms.js';
import { resolveSafeArtifactPath } from '../artifacts/paths.js';
import { buildTraceJson, buildMetadataJson, buildRoomIndex, buildTeacherIndex } from './payloads.js';
import { isCloudSyncEnabled, uploadObject } from './firebase.js';

export type UploadFn = (path: string, buffer: Buffer, contentType: string, contentDisposition?: string) => Promise<void>;

const POLL_INTERVAL_MS = 5_000;
const CLAIM_BATCH_SIZE = 3;

// Caches the last-written index content per room/teacher so it's only rewritten when it would
// differ — most metadata syncs change nothing an index contains. Lost on restart, costing one
// harmless extra rewrite.
//
// Keyed on the serialized index, not the entry-id list — an id-list key would miss field-only
// changes, e.g. a session flipping to `wrapped` without changing the id set.
const lastWrittenRoomIndex = new Map<string, string>();
const lastWrittenTeacherIndex = new Map<string, string>();

// Async: a multi-MB deck read synchronously here stalls the same event loop that is streaming
// live facilitation audio to a room mid-turn.
async function readLocalFile(sessionId: string, filename: string): Promise<Buffer | null> {
  const resolved = resolveSafeArtifactPath(sessionId, filename);
  if (!resolved) return null;
  return fsp.readFile(resolved);
}

async function maybeSyncRoomIndex(roomId: string, upload: UploadFn): Promise<void> {
  const serialized = JSON.stringify(buildRoomIndex(roomId));
  if (lastWrittenRoomIndex.get(roomId) === serialized) return;
  await upload(`${roomId}/index.json`, Buffer.from(serialized), 'application/json');
  lastWrittenRoomIndex.set(roomId, serialized);
}

async function maybeSyncTeacherIndex(teacherId: string, upload: UploadFn): Promise<void> {
  const serialized = JSON.stringify(buildTeacherIndex(teacherId));
  if (lastWrittenTeacherIndex.get(teacherId) === serialized) return;
  await upload(`_teachers/${teacherId}/index.json`, Buffer.from(serialized), 'application/json');
  lastWrittenTeacherIndex.set(teacherId, serialized);
}

/**
 * Uploads one queue row. `upload` is injected so tests can supply a fake and never touch the
 * network or initialize firebase-admin.
 */
export async function syncOne(row: CloudSyncQueueRow, upload: UploadFn): Promise<void> {
  const session = getSession(row.session_id);
  if (!session) throw new Error(`session_not_found:${row.session_id}`);
  const roomId = session.room_id;

  switch (row.kind) {
    case 'trace': {
      const trace = buildTraceJson(row.session_id);
      await upload(`${roomId}/${row.session_id}/trace.json`, Buffer.from(JSON.stringify(trace)), 'application/json');
      break;
    }
    case 'metadata': {
      const metadata = buildMetadataJson(roomId, row.session_id);
      await upload(`${roomId}/${row.session_id}/metadata.json`, Buffer.from(JSON.stringify(metadata)), 'application/json');
      const room = getRoom(roomId);
      await maybeSyncRoomIndex(roomId, upload);
      if (room) await maybeSyncTeacherIndex(room.owner_teacher_id, upload);
      break;
    }
    case 'prd': {
      const buffer = await readLocalFile(row.session_id, 'prd.md');
      if (!buffer) throw new Error(`prd_file_missing:${row.session_id}`);
      await upload(`${roomId}/${row.session_id}/prd.md`, buffer, 'text/markdown');
      break;
    }
    case 'landing': {
      const buffer = await readLocalFile(row.session_id, 'landing-page.html');
      if (!buffer) throw new Error(`landing_file_missing:${row.session_id}`);
      // Uploaded with a download-triggering disposition, not plain inline text/html, so a
      // future consumer of the object cannot accidentally render it without the
      // content-security-policy: sandbox the local route applies — this artifact is HTML
      // generated from untrusted group input.
      await upload(`${roomId}/${row.session_id}/landing-page.html`, buffer, 'text/html', 'attachment');
      break;
    }
    case 'pitch': {
      const pdf = await readLocalFile(row.session_id, 'deck.pdf');
      if (!pdf) throw new Error(`deck_file_missing:${row.session_id}`);
      await upload(`${roomId}/${row.session_id}/deck.pdf`, pdf, 'application/pdf');
      break;
    }
  }
}

let pollTimer: NodeJS.Timeout | null = null;
let ticking = false;

async function tick(upload: UploadFn): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    const rows = claimDue(CLAIM_BATCH_SIZE);
    for (const row of rows) {
      try {
        await syncOne(row, upload);
        markDone(row.id);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (row.attempts + 1 >= MAX_ATTEMPTS) console.warn(`[cloud-sync] row ${row.id} (${row.session_id}/${row.kind}) dead-lettered after ${MAX_ATTEMPTS} attempts: ${message}`);
        markRetry(row.id, message);
      }
    }
  } catch (err) {
    // claimDue() itself (or anything else in this tick) failing must never become an unhandled
    // rejection — the caller does `void tick(...)` inside a setInterval, and Node's default
    // unhandled-rejection behavior would crash the whole process, taking down every in-flight
    // SSE turn with it. A cloud-sync failure must never do that.
    console.error('[cloud-sync] poller tick failed', err);
  } finally {
    ticking = false;
  }
}

export function startCloudSyncPoller(): void {
  if (!isCloudSyncEnabled() || pollTimer) return;
  pollTimer = setInterval(() => {
    tick(uploadObject).catch((err) => console.error('[cloud-sync] poller tick failed', err));
  }, POLL_INTERVAL_MS);
  pollTimer.unref();
}

export function stopCloudSyncPoller(): void {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}
