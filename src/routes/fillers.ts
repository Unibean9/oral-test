import type { FastifyInstance } from 'fastify';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from '../claude-cli/spawn.js';
import { isWithin } from '../artifacts/paths.js';
import { apiError, apiOk, isPhaseKey, SUPPORTED_VOICES } from '../brainstorm/contracts.js';

const FILLERS_DIR = path.join(PROJECT_ROOT, 'assets', 'fillers');

// No /i flag: filenames are lower-case by construction (the generator only ever emits
// lower-case names), and isPhaseKey/SUPPORTED_VOICES membership below is case-sensitive — a
// case-insensitive regex here would let a case-varied filename (e.g. from a Windows rename)
// match the shape but then silently fail membership, parsing to null/null with no diagnostic.
const FILLER_NAME_RE = /^filler_([a-z-]+)_([a-z0-9-]+)_(\d{2})\.wav$/;
export function parseFillerName(name: string): { phase: string | null; voiceId: string | null } {
  const m = FILLER_NAME_RE.exec(name);
  if (!m) return { phase: null, voiceId: null };
  const phase = isPhaseKey(m[1]) ? m[1] : null;
  const voiceId = SUPPORTED_VOICES.some((v) => v.id === m[2]) ? m[2] : null;
  return phase && voiceId ? { phase, voiceId } : { phase: null, voiceId: null };
}

// resolveSafeArtifactPath is session-scoped (UUID + room/<id>/artifacts); fillers are a shared
// static asset dir with no session, so this reuses only its `isWithin` containment primitive.

async function realpathOrNull(target: string): Promise<string | null> {
  try { return await fsp.realpath(target); } catch { return null; }
}

// Every handler here is async: the synchronous fs calls these replaced ran on the same event
// loop that streams live facilitation audio, so a slow filesystem stalled in-flight SSE turns.
export async function fillerRoutes(app: FastifyInstance) {
  app.get('/fillers', async (_req, reply) => {
    let files: string[];
    try { files = await fsp.readdir(FILLERS_DIR); } catch { return reply.send(apiOk({ fillers: [] })); }
    const wavs = files.filter((f) => f.toLowerCase().endsWith('.wav'));
    // encodeURIComponent, because a filename containing '#', '?' or a space otherwise produced
    // a URL the client could not fetch back.
    return reply.send(apiOk({ fillers: wavs.map((f) => ({ name: f, url: `/fillers/${encodeURIComponent(f)}`, ...parseFillerName(f) })) }));
  });

  app.get<{ Params: { file: string } }>('/fillers/:file', async (req, reply) => {
    const file = req.params.file;
    if (!file || file.includes('..') || file.includes('\0') || path.isAbsolute(file)) return reply.code(400).send(apiError('invalid_file', 'Filler filename is not accepted'));
    // The same .wav filter the listing applies. Without it this route served ANY file that
    // happened to be in the directory, labelled audio/wav.
    if (!file.toLowerCase().endsWith('.wav')) return reply.code(404).send(apiError('not_found', 'No such filler'));
    const resolved = path.join(FILLERS_DIR, file);
    const real = await realpathOrNull(resolved);
    if (!real) return reply.code(404).send(apiError('not_found', 'No such filler'));
    const realFillersDir = (await realpathOrNull(FILLERS_DIR)) ?? FILLERS_DIR;
    // Shared containment helper — case-normalized, unlike the raw startsWith this replaced.
    if (!isWithin(real, realFillersDir)) return reply.code(400).send(apiError('invalid_file', 'Filler filename is not accepted'));
    return reply.type('audio/wav').send(fs.createReadStream(real));
  });
}
