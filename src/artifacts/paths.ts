import fs from 'node:fs';
import path from 'node:path';
import { validate as isUuid } from 'uuid';
import { SYSTEM_ROOT } from '../claude-cli/spawn.js';

// room/ lives under SYSTEM_ROOT (not PROJECT_ROOT) because that's the cwd Claude itself
// resolves relative Read/Write paths against - keeping this in sync with spawn.ts's cwd is
// what makes the guard-room.mjs hook's own path resolution match what Claude actually does.
// `runtimes/` is frozen: this on-disk `room/<uuid>/` layout keeps the word "room" for what the
// DB layer now calls a Session. `sessionId` here is that bare UUID, never the `rm_`-prefixed
// parent Room id from `rooms.room_id`.
const ROOM_DIR = path.join(SYSTEM_ROOT, 'room');

const IS_WINDOWS = process.platform === 'win32';

function canonical(p: string): string {
  const resolved = path.resolve(p);
  // Windows resolves paths case-insensitively, so a case-sensitive string comparison is not a
  // boundary: `Room\<id>` and `room\<id>` name the same file but only one matches a prefix
  // test. Canonicalize both sides before comparing. Mirrors guard-room.mjs's `canonical`.
  return IS_WINDOWS ? resolved.toLowerCase() : resolved;
}

/** True when `child` is `parent` itself or lies underneath it, compared canonically. */
export function isWithin(child: string, parent: string): boolean {
  const c = canonical(child);
  const p = canonical(parent);
  if (c === p) return true;
  const rel = path.relative(p, c);
  return rel !== '' && !rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel);
}

export function roomArtifactsDir(sessionId: string): string {
  return path.join(ROOM_DIR, sessionId, 'artifacts');
}

/**
 * BE-native path validation, independent of the room-scoping hook (which only governs
 * Claude's own tool calls, not the HTTP file-serving layer below). Shared by every route
 * module that serves a file by path parameter — every file-serving endpoint in this project
 * must go through this same realpath-containment check rather than reinventing it.
 *
 * The `isUuid` check is also what keeps the two id spaces non-interchangeable: a parent
 * `rm_`-prefixed room id can never satisfy it, so it can never resolve to an artifact path.
 * Never relax this check to accommodate room ids.
 */
export function resolveSafeArtifactPath(sessionId: string, file: string): string | null {
  if (!isUuid(sessionId)) return null;
  if (typeof file !== 'string' || file === '' || file.includes('\0') || path.isAbsolute(file)) return null;
  const artifactsDir = roomArtifactsDir(sessionId);
  // Lexical containment is checked against the LEXICAL dir and symlink containment against the
  // REAL one. Comparing a non-realpath candidate against a realpath root would reject every
  // lookup whenever an ancestor of runtimes/ is itself a symlink.
  const resolved = path.resolve(artifactsDir, file);
  if (!isWithin(resolved, artifactsDir)) return null;
  if (!fs.existsSync(resolved)) return null;
  const realArtifactsDir = fs.existsSync(artifactsDir) ? fs.realpathSync(artifactsDir) : artifactsDir;
  const real = fs.realpathSync(resolved);
  if (!isWithin(real, realArtifactsDir)) return null;
  return real;
}
