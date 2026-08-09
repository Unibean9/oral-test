import { db } from './connection.js';
import { isCloudSyncEnabled } from '../cloud/firebase.js';

export type SyncKind = 'trace' | 'metadata' | 'prd' | 'landing' | 'pitch';
export type SyncStatus = 'pending' | 'syncing' | 'done' | 'failed';

export interface CloudSyncQueueRow {
  id: number;
  session_id: string;
  kind: SyncKind;
  status: SyncStatus;
  attempts: number;
  last_error: string | null;
  next_attempt_at: string;
  created_at: string;
  updated_at: string;
}

export const MAX_ATTEMPTS = 10;
const DEBOUNCE_MS = 3_000;
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_CAP_MS = 30 * 60_000;

// Up to +25% jitter. Without it, every row that failed during the same bucket outage retries in
// lockstep, so each recovery attempt arrives as one synchronized burst.
function backoffMs(attempts: number): number {
  const base = Math.min(2 ** attempts * BACKOFF_BASE_MS, BACKOFF_CAP_MS);
  return Math.round(base * (1 + Math.random() * 0.25));
}

const selectByKey = db.prepare('SELECT * FROM cloud_sync_queue WHERE session_id = ? AND kind = ?');
const insertRow = db.prepare(`
  INSERT INTO cloud_sync_queue (session_id, kind, status, attempts, next_attempt_at, created_at, updated_at)
  VALUES (?, ?, 'pending', 0, ?, ?, ?)
`);
const resetToPendingStmt = db.prepare("UPDATE cloud_sync_queue SET status = 'pending', attempts = 0, next_attempt_at = ?, updated_at = ? WHERE id = ?");
// Same reset, but WITHOUT clearing the attempt budget — used for rows that already
// dead-lettered. Resetting the budget here meant an active session — which enqueues on every
// turn — re-armed the full 10-attempt ladder indefinitely against a misconfigured bucket, so the
// row never stayed `failed` long enough to appear on GET /cloud-sync/status.
const requeueFailedKeepingBudgetStmt = db.prepare("UPDATE cloud_sync_queue SET status = 'pending', next_attempt_at = ?, updated_at = ? WHERE id = ?");

/**
 * Upsert on (session_id, kind) — the debounce state machine:
 *   absent  -> insert pending, next_attempt_at = now + DEBOUNCE_MS
 *   pending -> no-op (first-write-wins: bounds latency under a re-enqueue burst)
 *   syncing -> no-op; a newer snapshot is picked up by a later enqueue, not the in-flight
 *              upload — accepted because uploads are idempotent full overwrites
 *   done    -> reset to pending, attempts = 0, next_attempt_at = now + DEBOUNCE_MS
 *   failed  -> requeue to pending but KEEP attempts and its own backoff, not the debounce —
 *              an active session enqueues every turn, so resetting the budget here would keep
 *              re-arming the retry ladder against a permanently broken bucket
 *
 * No-op entirely when cloud sync is disabled, so rows don't pile up `pending` with nothing to
 * drain them.
 */
export const enqueue = db.transaction((sessionId: string, kind: SyncKind): void => {
  if (!isCloudSyncEnabled()) return;
  const existing = selectByKey.get(sessionId, kind) as CloudSyncQueueRow | undefined;
  const now = new Date().toISOString();
  const debouncedAt = new Date(Date.now() + DEBOUNCE_MS).toISOString();
  if (!existing) {
    insertRow.run(sessionId, kind, debouncedAt, now, now);
    return;
  }
  if (existing.status === 'pending' || existing.status === 'syncing') return;
  if (existing.status === 'failed') {
    // Keep whichever is later: an already-scheduled future attempt, or one backoff step from now.
    // Date.parse yields NaN on a malformed stored timestamp, and Math.max(NaN, x) is NaN, which
    // would write the literal string "Invalid Date" into next_attempt_at.
    const scheduledFor = Date.parse(existing.next_attempt_at);
    const scheduled = new Date(Math.max(
      Number.isNaN(scheduledFor) ? 0 : scheduledFor,
      Date.now() + backoffMs(existing.attempts),
    )).toISOString();
    requeueFailedKeepingBudgetStmt.run(scheduled, now, existing.id);
    return;
  }
  resetToPendingStmt.run(debouncedAt, now, existing.id);
});

const claimDueStmt = db.prepare(`
  UPDATE cloud_sync_queue SET status = 'syncing', updated_at = ?
  WHERE id IN (
    SELECT id FROM cloud_sync_queue WHERE status = 'pending' AND next_attempt_at <= ? ORDER BY next_attempt_at ASC LIMIT ?
  )
  RETURNING *
`);
export function claimDue(limit = 3): CloudSyncQueueRow[] {
  const now = new Date().toISOString();
  return claimDueStmt.all(now, now, limit) as CloudSyncQueueRow[];
}

const markDoneStmt = db.prepare(`
  UPDATE cloud_sync_queue SET status = 'done', updated_at = ? WHERE id = ? AND status = 'syncing'
`);
/** The `WHERE status = 'syncing'` guard makes this a no-op if the row was somehow already moved
 *  out of 'syncing' by something else. */
export function markDone(id: number): void {
  const now = new Date().toISOString();
  markDoneStmt.run(now, id);
}

const markRetryOrFailedStmt = db.prepare(`
  UPDATE cloud_sync_queue
  SET status = CASE WHEN attempts + 1 >= ? THEN 'failed' ELSE 'pending' END,
      attempts = attempts + 1,
      next_attempt_at = ?,
      last_error = ?,
      updated_at = ?
  WHERE id = ? AND status = 'syncing'
`);
const selectAttemptsStmt = db.prepare('SELECT attempts FROM cloud_sync_queue WHERE id = ?');
/**
 * The attempt count is read from the DB inside the same transaction as the update, rather than
 * taken from a caller-supplied snapshot. Previously the backoff was computed from the caller's
 * stale `attempts` while the failed/pending decision used the DB's `attempts + 1` — two sources
 * of truth for one counter, which drift as soon as anything else touches the row.
 */
export const markRetry = db.transaction((id: number, error: string): void => {
  const now = new Date().toISOString();
  const row = selectAttemptsStmt.get(id) as { attempts: number } | undefined;
  if (!row) return;
  const nextAttemptAt = new Date(Date.now() + backoffMs(row.attempts + 1)).toISOString();
  markRetryOrFailedStmt.run(MAX_ATTEMPTS, nextAttemptAt, error.slice(0, 500), now, id);
});

const recoverStuckStmt = db.prepare("UPDATE cloud_sync_queue SET status = 'pending', updated_at = ? WHERE status = 'syncing'");
export function recoverStuckSyncs(): void {
  recoverStuckStmt.run(new Date().toISOString());
}

const requeueFailedStmt = db.prepare("UPDATE cloud_sync_queue SET status = 'pending', attempts = 0, next_attempt_at = ?, updated_at = ? WHERE status = 'failed'");
/**
 * Gives a dead-lettered row an explicit path back to `pending` (e.g. once bucket credentials
 * are repaired), rather than waiting for some future enqueue to touch that (session_id, kind)
 * again. Not an automatic backfill/reconciliation sweep — a scoped, manually-triggered action.
 */
export function requeueFailed(): number {
  const now = new Date().toISOString();
  const result = requeueFailedStmt.run(now, now);
  return result.changes;
}

const statsStmt = db.prepare('SELECT status, COUNT(*) AS n FROM cloud_sync_queue GROUP BY status');
const failedRowsStmt = db.prepare("SELECT * FROM cloud_sync_queue WHERE status = 'failed' ORDER BY updated_at DESC");
export function queueStats(): { counts: Record<SyncStatus, number>; failedRows: CloudSyncQueueRow[] } {
  const counts: Record<SyncStatus, number> = { pending: 0, syncing: 0, done: 0, failed: 0 };
  for (const row of statsStmt.all() as Array<{ status: SyncStatus; n: number }>) counts[row.status] = row.n;
  return { counts, failedRows: failedRowsStmt.all() as CloudSyncQueueRow[] };
}
