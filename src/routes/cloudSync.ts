import type { FastifyInstance } from 'fastify';
import { API_PREFIX, apiOk } from '../brainstorm/contracts.js';
import { queueStats, requeueFailed } from '../db/cloudSyncQueue.js';

/**
 * The stored `last_error` is the raw SDK message, which for GCS routinely embeds the bucket
 * name, full object paths and the service-account email. It stays intact in the DB for
 * operator log-side diagnosis, but the wire form is a coarse classification plus a short,
 * path-free excerpt — this endpoint has no teacher check and is reachable from any allowed
 * browser origin.
 */
function classifyError(raw: string | null): { code: string; hint: string } | null {
  if (!raw) return null;
  const text = raw.toLowerCase();
  if (text.includes('upload_timeout')) return { code: 'upload_timeout', hint: 'The storage upload did not complete in time.' };
  if (text.includes('permission') || text.includes('forbidden') || text.includes('unauthorized') || text.includes('credential')) {
    return { code: 'permission_denied', hint: 'Storage rejected the credentials or the bucket permissions.' };
  }
  if (text.includes('not found') || text.includes('404') || text.includes('_missing')) return { code: 'source_missing', hint: 'The object or its local source file was not found.' };
  if (text.includes('enotfound') || text.includes('econnreset') || text.includes('etimedout') || text.includes('network')) {
    return { code: 'network_unavailable', hint: 'Storage was unreachable.' };
  }
  return { code: 'upload_failed', hint: 'The upload failed; see the server log for details.' };
}

// No X-Teacher-Id required on either route: these are local recovery/observability actions
// against this instance's own queue, not security-sensitive in the identification-only model
// this backend uses (see brainstorm/teacherContext.ts).
export async function cloudSyncRoutes(app: FastifyInstance) {
  app.get(`${API_PREFIX}/cloud-sync/status`, async (_req, reply) => {
    const { counts, failedRows } = queueStats();
    return reply.send(apiOk({
      counts,
      failed: failedRows.map((row) => ({
        id: row.id,
        sessionId: row.session_id,
        kind: row.kind,
        attempts: row.attempts,
        lastError: classifyError(row.last_error),
        updatedAt: row.updated_at,
      })),
    }));
  });

  app.post(`${API_PREFIX}/cloud-sync/retry`, async (_req, reply) => {
    const requeued = requeueFailed();
    return reply.send(apiOk({ requeued }));
  });
}
