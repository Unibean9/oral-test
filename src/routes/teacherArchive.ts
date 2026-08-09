import type { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import { validate as isUuid } from 'uuid';
import { API_PREFIX, apiOk, apiError, isRoomId } from '../brainstorm/contracts.js';
import { isCloudSyncEnabled } from '../cloud/firebase.js';
import { downloadObject, objectExists } from '../cloud/read.js';
import { buildMetadataJson, buildRoomIndex, buildTeacherIndex, buildTraceJson } from '../cloud/payloads.js';
import { listRooms, listSessionsInRoom } from '../db/rooms.js';
import { getTrace } from '../db/sessions.js';
import { resolveSafeArtifactPath } from '../artifacts/paths.js';

/**
 * The 5 object kinds the write path (cloud/outbox.ts's `syncOne`) ever uploads. This allowlist is
 * the SECOND, independent layer of defence against reading something the archive should not
 * serve — the actual reason something like `transcript.json` or `trace-summary.md` can never be
 * fetched through this route today is that the write path never uploads objects with those
 * names, so they simply never exist in the bucket under any roomId/sessionId. If a sync kind is
 * ever added on the write side without a matching update here, THAT is the real residual risk;
 * this allowlist alone does not create the safety property, it only preserves it.
 *
 * A `Map`, not a plain object literal: an object-literal truthiness lookup (`OBJ[artifact]`)
 * resolves `artifact = "constructor"` or `"toString"` to an inherited built-in function, which is
 * truthy and would incorrectly pass an allowlist check written as `if (OBJ[artifact])`.
 * `Map#has` has no prototype chain to leak through.
 */
export const ARCHIVE_ARTIFACTS = new Map<string, { contentType: string }>([
  ['trace.json', { contentType: 'application/json' }],
  ['metadata.json', { contentType: 'application/json' }],
  ['prd.md', { contentType: 'text/markdown' }],
  ['landing-page.html', { contentType: 'text/html' }],
  ['deck.pdf', { contentType: 'application/pdf' }],
]);

// trace.json and metadata.json are never written to disk under room/<id>/artifacts; they are
// synthesized on demand from SQLite via buildTraceJson/buildMetadataJson, both when uploaded and
// in the cloud-disabled local fallback below. Only prd.md/landing-page.html/deck.pdf are real
// local files.

/**
 * `roomId`/`sessionId` are concatenated directly into a GCS object path below. Fastify
 * percent-decodes route params before a handler sees them, so `%2F` arrives already decoded to
 * `/` — without validation, a crafted param could escape the `{roomId}/{sessionId}/` segment and
 * read any object in the bucket. Two redundant layers guard it: reject `/`, `\`, `..`, `%`, NUL
 * outright, and require strict id shape (UUID / `rm_`-prefixed) on top.
 */
const UNSAFE_PARAM_RE = /[\\/%\0 ]|\.\./;
function isUnsafeParam(value: string): boolean {
  return typeof value !== 'string' || value === '' || UNSAFE_PARAM_RE.test(value);
}
function isSafeTeacherId(value: string): boolean { return !isUnsafeParam(value) && isUuid(value); }
function isSafeRoomId(value: string): boolean { return !isUnsafeParam(value) && isRoomId(value); }
function isSafeSessionId(value: string): boolean { return !isUnsafeParam(value) && isUuid(value); }

function notFound(reply: any) {
  return reply.code(404).send(apiError('archive_not_found', 'The requested archive object was not found'));
}

export async function teacherArchiveRoutes(app: FastifyInstance) {
  // GET /teachers/:teacherId/archive -> { enabled, rooms: [...] }
  app.get<{ Params: { teacherId: string } }>(`${API_PREFIX}/teachers/:teacherId/archive`, async (req, reply) => {
    const { teacherId } = req.params;
    if (!isSafeTeacherId(teacherId)) return reply.code(422).send(apiError('invalid_teacher_id', 'teacherId must be a UUID'));

    if (!isCloudSyncEnabled()) {
      // Local-only fallback, sourced from SQLite, not the bucket. `enabled: false` is the flag
      // the UI uses to say "you are viewing local data, not the cloud archive" — never described
      // as a security signal, X-Teacher-Id is identification only per this project's constraints.
      const rooms = listRooms()
        .filter((r) => r.owner_teacher_id === teacherId)
        .map((r) => ({ roomId: r.room_id, name: r.name }));
      return reply.send(apiOk({ enabled: false, rooms }));
    }

    let buffer: Buffer | null;
    try {
      buffer = await downloadObject(`_teachers/${teacherId}/index.json`);
    } catch (err) {
      req.log.error({ err }, 'archive: teacher index download failed');
      return reply.code(502).send(apiError('archive_read_failed', 'Could not read the archive index'));
    }
    // A missing index is NOT an error: the index is only written the first time a `metadata`
    // sync kind runs (cloud/outbox.ts's maybeSyncTeacherIndex), so a teacher who has never wrapped
    // a session yet has simply never had one written — "nothing archived yet", not a fault.
    if (!buffer) return reply.send(apiOk({ enabled: true, rooms: [] }));
    let index: ReturnType<typeof buildTeacherIndex>;
    try {
      index = JSON.parse(buffer.toString('utf8'));
    } catch (err) {
      req.log.error({ err }, 'archive: teacher index parse failed');
      return reply.code(502).send(apiError('archive_read_failed', 'Could not read the archive index'));
    }
    return reply.send(apiOk({ enabled: true, rooms: index.rooms }));
  });

  // GET /teachers/:teacherId/archive/:roomId -> { enabled, sessions: [...] }
  app.get<{ Params: { teacherId: string; roomId: string } }>(`${API_PREFIX}/teachers/:teacherId/archive/:roomId`, async (req, reply) => {
    const { teacherId, roomId } = req.params;
    if (!isSafeTeacherId(teacherId)) return reply.code(422).send(apiError('invalid_teacher_id', 'teacherId must be a UUID'));
    if (!isSafeRoomId(roomId)) return reply.code(422).send(apiError('invalid_room_id', 'roomId must be an rm_-prefixed id'));

    if (!isCloudSyncEnabled()) {
      const sessions = listSessionsInRoom(roomId).map((s) => ({ sessionId: s.session_id, name: s.name, status: s.status }));
      return reply.send(apiOk({ enabled: false, sessions }));
    }

    let buffer: Buffer | null;
    try {
      buffer = await downloadObject(`${roomId}/index.json`);
    } catch (err) {
      req.log.error({ err }, 'archive: room index download failed');
      return reply.code(502).send(apiError('archive_read_failed', 'Could not read the archive index'));
    }
    if (!buffer) return reply.send(apiOk({ enabled: true, sessions: [] }));
    let index: ReturnType<typeof buildRoomIndex>;
    try {
      index = JSON.parse(buffer.toString('utf8'));
    } catch (err) {
      req.log.error({ err }, 'archive: room index parse failed');
      return reply.code(502).send(apiError('archive_read_failed', 'Could not read the archive index'));
    }
    return reply.send(apiOk({ enabled: true, sessions: index.sessions }));
  });

  // GET /teachers/:teacherId/archive/:roomId/:sessionId -> { enabled, metadata, artifacts }
  app.get<{ Params: { teacherId: string; roomId: string; sessionId: string } }>(
    `${API_PREFIX}/teachers/:teacherId/archive/:roomId/:sessionId`,
    async (req, reply) => {
      const { teacherId, roomId, sessionId } = req.params;
      if (!isSafeTeacherId(teacherId)) return reply.code(422).send(apiError('invalid_teacher_id', 'teacherId must be a UUID'));
      if (!isSafeRoomId(roomId)) return reply.code(422).send(apiError('invalid_room_id', 'roomId must be an rm_-prefixed id'));
      if (!isSafeSessionId(sessionId)) return reply.code(422).send(apiError('invalid_session_id', 'sessionId must be a UUID'));

      if (!isCloudSyncEnabled()) {
        let metadata: unknown;
        try {
          metadata = buildMetadataJson(roomId, sessionId);
        } catch {
          return notFound(reply);
        }
        const artifacts: Record<string, boolean> = {
          'trace.json': getTrace(sessionId).length > 0,
          'metadata.json': true,
          'prd.md': Boolean(resolveSafeArtifactPath(sessionId, 'prd.md')),
          'landing-page.html': Boolean(resolveSafeArtifactPath(sessionId, 'landing-page.html')),
          'deck.pdf': Boolean(resolveSafeArtifactPath(sessionId, 'deck.pdf')),
        };
        return reply.send(apiOk({ enabled: false, metadata, artifacts }));
      }

      let metadataBuffer: Buffer | null;
      try {
        metadataBuffer = await downloadObject(`${roomId}/${sessionId}/metadata.json`);
      } catch (err) {
        req.log.error({ err }, 'archive: metadata download failed');
        return reply.code(502).send(apiError('archive_read_failed', 'Could not read the session metadata'));
      }
      // Unlike the two index reads above, a missing metadata.json for a SPECIFIC, validly-shaped
      // session id is treated as not-found rather than "nothing yet" — the caller named an exact
      // session, so an absent object is either a wrong id or one that never wrapped.
      if (!metadataBuffer) return notFound(reply);
      // Accept either metadata shape — an object already in the bucket may carry fields the
      // current payload builder no longer writes. Whatever is stored is returned as-is; the
      // caller only reads fields it recognizes.
      let metadata: unknown;
      try {
        metadata = JSON.parse(metadataBuffer.toString('utf8'));
      } catch (err) {
        req.log.error({ err }, 'archive: metadata parse failed');
        return reply.code(502).send(apiError('archive_read_failed', 'Could not read the session metadata'));
      }

      const otherNames = [...ARCHIVE_ARTIFACTS.keys()].filter((name) => name !== 'metadata.json');
      let presence: readonly (readonly [string, boolean])[];
      try {
        presence = await Promise.all(
          otherNames.map(async (name) => [name, await objectExists(`${roomId}/${sessionId}/${name}`)] as const),
        );
      } catch (err) {
        req.log.error({ err }, 'archive: artifact presence probe failed');
        return reply.code(502).send(apiError('archive_read_failed', 'Could not read the session artifacts'));
      }
      const artifacts: Record<string, boolean> = { 'metadata.json': true };
      for (const [name, exists] of presence) artifacts[name] = exists;

      return reply.send(apiOk({ enabled: true, metadata, artifacts }));
    },
  );

  // GET /teachers/:teacherId/archive/:roomId/:sessionId/:artifact -> raw file, proxy-streamed
  app.get<{ Params: { teacherId: string; roomId: string; sessionId: string; artifact: string } }>(
    `${API_PREFIX}/teachers/:teacherId/archive/:roomId/:sessionId/:artifact`,
    async (req, reply) => {
      const { teacherId, roomId, sessionId, artifact } = req.params;
      if (!isSafeTeacherId(teacherId)) return reply.code(422).send(apiError('invalid_teacher_id', 'teacherId must be a UUID'));
      if (!isSafeRoomId(roomId)) return reply.code(422).send(apiError('invalid_room_id', 'roomId must be an rm_-prefixed id'));
      if (!isSafeSessionId(sessionId)) return reply.code(422).send(apiError('invalid_session_id', 'sessionId must be a UUID'));
      // Map#has, never an object-literal truthiness lookup — see ARCHIVE_ARTIFACTS's docblock.
      if (isUnsafeParam(artifact) || !ARCHIVE_ARTIFACTS.has(artifact)) {
        return reply.code(422).send(apiError('invalid_artifact', 'artifact must be one of the known archive object kinds'));
      }
      const spec = ARCHIVE_ARTIFACTS.get(artifact)!;

      const applyLandingPageHeaders = () => {
        // This is model-authored HTML from untrusted group input. Matches the same two headers
        // the local landing-page serving route applies (routes/sessionArtifacts.ts): forced
        // download rather than inline render, plus a sandboxing CSP as a second layer in case a
        // browser is ever pointed at this URL directly instead of via a download.
        reply.header('content-disposition', 'attachment; filename="landing-page.html"');
        reply.header('content-security-policy', 'sandbox');
      };

      if (!isCloudSyncEnabled()) {
        if (artifact === 'trace.json') {
          let payload: unknown;
          try { payload = buildTraceJson(sessionId); } catch { return notFound(reply); }
          return reply.type(spec.contentType).send(Buffer.from(JSON.stringify(payload)));
        }
        if (artifact === 'metadata.json') {
          let payload: unknown;
          try { payload = buildMetadataJson(roomId, sessionId); } catch { return notFound(reply); }
          return reply.type(spec.contentType).send(Buffer.from(JSON.stringify(payload)));
        }
        // LOCAL_FILE_ARTIFACTS: served straight off disk via the same containment check every
        // other file-serving route in this project uses.
        const localPath = resolveSafeArtifactPath(sessionId, artifact);
        if (!localPath) return notFound(reply);
        if (artifact === 'landing-page.html') applyLandingPageHeaders();
        return reply.type(spec.contentType).send(fs.createReadStream(localPath));
      }

      let buffer: Buffer | null;
      try {
        buffer = await downloadObject(`${roomId}/${sessionId}/${artifact}`);
      } catch (err) {
        req.log.error({ err }, 'archive: artifact download failed');
        return reply.code(502).send(apiError('archive_read_failed', 'Could not read the archived artifact'));
      }
      if (!buffer) return notFound(reply);
      if (artifact === 'landing-page.html') applyLandingPageHeaders();
      return reply.type(spec.contentType).send(buffer);
    },
  );
}
