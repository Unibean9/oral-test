// Lazy Admin SDK init: a teacher who never enables cloud sync never pulls firebase-admin into
// the process. Env contract: GOOGLE_APPLICATION_CREDENTIALS (absolute path to a service-account
// JSON kept outside the repo) and FIREBASE_STORAGE_BUCKET. Both must be set for cloud sync to
// activate; with either unset, every existing flow works untouched and no queue rows are ever
// written (see db/cloudSyncQueue.ts's enqueue, which no-ops when this is disabled).

// Caches the in-flight PROMISE, not the resolved bucket. Caching the resolved value left two
// await points between the check and the assignment, so two concurrent callers could both pass
// the guard and race on initializeApp().
let bucketPromise: Promise<any> | null = null;

/** A stalled upload (or, since the read path was added, a stalled download) must not be able to
 *  wedge the poller / an archive request, which holds its tick/response open across the await. */
export const UPLOAD_TIMEOUT_MS = 60_000;

export function isCloudSyncEnabled(): boolean {
  return Boolean(process.env.GOOGLE_APPLICATION_CREDENTIALS && process.env.FIREBASE_STORAGE_BUCKET);
}

/** Exported so `cloud/read.ts` reuses this same lazily-initialized, promise-cached bucket instead
 *  of duplicating the Admin SDK init logic (and its concurrent-init race guard) a second time. */
export function getBucket(): Promise<any> {
  if (bucketPromise) return bucketPromise;
  bucketPromise = (async () => {
    const admin = await import('firebase-admin');
    const bucketName = process.env.FIREBASE_STORAGE_BUCKET as string;
    const app = admin.default.apps.length
      ? admin.default.app()
      : admin.default.initializeApp({ credential: admin.default.credential.applicationDefault(), storageBucket: bucketName });
    // Never log the credential path's contents, only that sync is enabled and which bucket.
    console.log(`[cloud] sync enabled, bucket=${bucketName}`);
    return admin.default.storage(app).bucket(bucketName);
  })().catch((err) => {
    // Don't cache a failed init — the next attempt should be able to retry it.
    bucketPromise = null;
    throw err;
  });
  return bucketPromise;
}

export async function uploadObject(path: string, buffer: Buffer, contentType: string, contentDisposition?: string): Promise<void> {
  const bucket = await getBucket();
  const metadata: Record<string, string> = { contentType };
  if (contentDisposition) metadata.contentDisposition = contentDisposition;
  // `save()` has no built-in timeout. Against a blackholed connection it never settles, and the
  // poller's `ticking` latch stays true forever: every later tick returns immediately, the row
  // stays 'syncing' so backoff never engages, and only a process restart recovers.
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`upload_timeout after ${UPLOAD_TIMEOUT_MS}ms`)), UPLOAD_TIMEOUT_MS);
  });
  try {
    await Promise.race([bucket.file(path).save(buffer, { metadata, resumable: true }), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
