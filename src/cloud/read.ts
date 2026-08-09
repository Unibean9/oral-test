import { getBucket, UPLOAD_TIMEOUT_MS } from './firebase.js';
import { seam } from '../brainstorm/testSeam.js';

/**
 * Downloads one object from the bucket, or `null` if it does not exist. Uses `file.download()`
 * directly rather than `file.exists()` + download, which would be two round-trips with a delete
 * race for no benefit over handling a 404. Shares `uploadObject`'s `Promise.race` timeout pattern
 * so a stalled read can't hold the event loop open indefinitely. Wrapped in `seam()` (rather than
 * a caller-injected parameter) because `routes/teacherArchive.ts` calls this directly from
 * several branches; tests substitute a fake via `.setForTests(...)`.
 */
async function downloadObjectImpl(path: string): Promise<Buffer | null> {
  const bucket = await getBucket();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`download_timeout after ${UPLOAD_TIMEOUT_MS}ms`)), UPLOAD_TIMEOUT_MS);
  });
  try {
    const [buffer] = await Promise.race([bucket.file(path).download(), timeout]);
    return buffer as Buffer;
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    if (code === 404) return null;
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
export const downloadObject = seam(downloadObjectImpl);

/**
 * Cheap existence probe (a metadata-only round trip, not a content download) used ONLY to report
 * which of the 5 allowlisted artifact names exist for a session's archive listing — never
 * followed by an immediate download of the same object, so this is not the exists()-then-download
 * race `downloadObject` above avoids. Not `bucket.getFiles({prefix})`: that lists every object
 * under a prefix, which is unbounded and unnecessary when the 5 candidate names are already known.
 * Also seamed, for the same reason as `downloadObject` above.
 */
async function objectExistsImpl(path: string): Promise<boolean> {
  const bucket = await getBucket();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`exists_timeout after ${UPLOAD_TIMEOUT_MS}ms`)), UPLOAD_TIMEOUT_MS);
  });
  try {
    const [exists] = await Promise.race([bucket.file(path).exists(), timeout]);
    return Boolean(exists);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
export const objectExists = seam(objectExistsImpl);
