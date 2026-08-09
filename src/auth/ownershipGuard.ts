import type { FastifyReply, FastifyRequest } from 'fastify';
import { apiError } from '../contracts.js';

/**
 * Fastify preHandler factory: verifies the teacher JWT, then resolves the target resource's
 * owning teacher_id via `resolveOwnerTeacherId(req)` and rejects if it doesn't match the caller.
 *
 * - No/invalid token -> 401.
 * - `resolveOwnerTeacherId` returns undefined (resource does not exist, or the id shape does not
 *   belong to this domain) -> 404. Checked BEFORE the ownership comparison so a wrong-owner probe
 *   against a real resource (403) is distinguishable from a nonexistent one (404) without leaking
 *   existence to a caller who isn't the owner — both a stranger and the true owner get the same
 *   404 for a resource that truly doesn't exist.
 * - Resolved owner doesn't match the JWT's teacherId -> 403.
 * - Otherwise the handler runs; `req.teacherId` is set for handlers that need it.
 */
export function ownershipGuard(
  resolveOwnerTeacherId: (req: FastifyRequest) => string | undefined,
) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    try {
      await req.jwtVerify();
    } catch {
      reply.code(401).send(apiError('unauthenticated', 'A valid teacher session is required'));
      return;
    }
    const ownerTeacherId = resolveOwnerTeacherId(req);
    if (!ownerTeacherId) {
      reply.code(404).send(apiError('not_found', 'Resource was not found'));
      return;
    }
    const callerTeacherId = req.user.teacherId;
    if (ownerTeacherId !== callerTeacherId) {
      reply.code(403).send(apiError('forbidden', 'You do not own this resource'));
      return;
    }
    (req as FastifyRequest & { teacherId: string }).teacherId = callerTeacherId;
  };
}
