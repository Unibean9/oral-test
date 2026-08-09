import fs from 'node:fs';

/**
 * Cheap single-writer lock: this backend is a single-process localhost service, and multiple
 * instances sharing one SQLite DB is not a real distributed-systems threat worth a lease/
 * heartbeat/watchdog protocol. A pidfile beside the DB is enough — refuse to boot if a live
 * process already holds it, clean up a stale one left by a crash, and remove it on graceful
 * shutdown.
 */
function lockPathFor(dbPath: string): string {
  return `${dbPath}.lock`;
}

/** True if `pid` names a live process this machine still has (ESRCH means dead). */
function isPidAlive(pid: number): boolean {
  try {
    // Signal 0 does not actually send a signal — it only tests whether the process exists and
    // is (at least partially) visible to us. EPERM means it exists but is owned by someone
    // else, which still counts as alive for this purpose.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/**
 * Attempts to reclaim `lockPath` from a stale (crashed) holder and retries the atomic create
 * once. Throws the clear conflict error if the holder turns out to still be alive, or rethrows
 * the original EEXIST if the file vanished/reappeared out from under us (rare, but the retry
 * itself must not be allowed to loop forever).
 */
function reclaimStaleLockAndRetry(lockPath: string, dbPath: string, originalErr: unknown): void {
  let raw: string;
  try {
    raw = fs.readFileSync(lockPath, 'utf8').trim();
  } catch {
    // Lockfile disappeared between the failed create and this read (another process just
    // released it) — just retry the atomic create.
    fs.writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
    return;
  }
  const pid = Number.parseInt(raw, 10);
  if (Number.isFinite(pid) && isPidAlive(pid)) {
    throw new Error(
      `another instance (pid ${pid}) already holds the single-writer lock for ${dbPath} (${lockPath}). ` +
        'Stop that process before starting a new one.',
    );
  }
  // Stale lockfile from a crash (or an unparseable one) — the holder is gone, safe to reclaim.
  fs.rmSync(lockPath, { force: true });
  try {
    fs.writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
  } catch (retryErr) {
    // Another process won the race to recreate it after we removed the stale file — surface
    // that as the conflict rather than the original error.
    if ((retryErr as NodeJS.ErrnoException).code === 'EEXIST') {
      reclaimStaleLockAndRetry(lockPath, dbPath, retryErr);
      return;
    }
    throw retryErr ?? originalErr;
  }
}

/**
 * Acquires the single-writer lock for `dbPath`, or throws with a clear message naming the
 * blocking pid if another live process already holds it. Call once at boot, before any other
 * process touches the DB for real work. Pair with `releaseSingleWriterLock` on shutdown.
 *
 * The create is an atomic exclusive `wx` write — two processes racing to boot simultaneously
 * cannot both observe "no lock" and both succeed, unlike a prior existsSync/readFileSync/
 * rmSync/writeFileSync sequence, which had a TOCTOU window between the existence check and the
 * write where the second process's write silently clobbered the first's.
 */
export function acquireSingleWriterLock(dbPath: string): void {
  const lockPath = lockPathFor(dbPath);
  try {
    fs.writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    reclaimStaleLockAndRetry(lockPath, dbPath, err);
  }
}

/** Removes the lockfile on graceful shutdown. Safe to call even if the lock was never acquired. */
export function releaseSingleWriterLock(dbPath: string): void {
  fs.rmSync(lockPathFor(dbPath), { force: true });
}
