#!/usr/bin/env node
// Room-scoping PreToolUse hook.
//
// Policy, for a room-spawned session (ROOM_ID set):
//   DENY BY DEFAULT. The only filesystem location a room session may touch —
//   read, write, edit, search — is room/<ROOM_ID>/artifacts/. This is exactly what all
//   three SKILL.md files promise; the hook now enforces it instead of merely echoing it.
//   Tools that can reach the filesystem or the network by another route (Bash, WebFetch,
//   WebSearch, Task, ...) are denied outright.
//
// If ROOM_ID is unset -> ALLOW: this hook is registered in the same shared settings.json
// used by ordinary, non-room Claude Code sessions in this repo, and those never set
// ROOM_ID, so it must not disable normal usage the moment it's registered.
//
// FAIL CLOSED. Every unexpected condition — malformed stdin, an unknown tool-input shape,
// a non-string path, an fs error, an uncaught throw — produces a deny, never an allow.
// A PreToolUse hook only blocks on exit code 2 or an explicit deny decision; any other
// non-zero exit is a non-blocking error and the tool proceeds, so errors must not be
// left to fall through to a generic non-zero exit.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const IS_WINDOWS = process.platform === 'win32';

// Tools that can create or mutate a file. `--allowedTools=Write,Read` is an auto-approval
// list, not a tool allowlist, and `--permission-mode acceptEdits` independently auto-accepts
// the whole edit family — so every one of these must be scoped here, not just Write.
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const READ_TOOLS = new Set(['Read', 'NotebookRead']);
// Search tools take an optional `path` that defaults to the whole project when omitted,
// which is itself an escape — an omitted path is denied below rather than treated as "no path".
const SEARCH_TOOLS = new Set(['Grep', 'Glob']);
// Reach the filesystem or the network without a path argument this hook could scope.
const FORBIDDEN_TOOLS = new Set(['Bash', 'BashOutput', 'KillShell', 'WebFetch', 'WebSearch', 'Task', 'SlashCommand']);

const PATH_KEYS = ['file_path', 'path', 'notebook_path', 'filePath', 'notebookPath'];

/**
 * Canonical form for containment comparison. On Windows the filesystem is case-insensitive
 * and accepts several spellings of the same path, so a case-sensitive string comparison is
 * not a boundary: `Room\<other-uuid>` and `room\<other-uuid>` name the same file but only
 * one of them matches a `startsWith` test.
 */
function canonical(p) {
  let out = path.resolve(p);
  if (IS_WINDOWS) out = out.toLowerCase();
  return out;
}

/** True when `child` is `parent` itself or lies underneath it, compared canonically. */
function isWithin(child, parent) {
  const c = canonical(child);
  const p = canonical(parent);
  if (c === p) return true;
  const rel = path.relative(p, c);
  return rel !== '' && !rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel);
}

/**
 * Path spellings that bypass Win32 normalization or alias a long name, neither of which
 * survives a textual containment check. Rejected outright rather than normalized.
 */
function hasUnsafeSpelling(raw) {
  if (typeof raw !== 'string' || raw === '') return true;
  if (raw.includes('\u0000')) return true;
  if (/^\\\\[?.]\\/.test(raw)) return true; // \\?\ and \\.\ extended-length / device prefixes
  if (/^\\\\/.test(raw) || /^\/\//.test(raw)) return true; // UNC share
  if (/(^|[\\/])[^\\/]*~\d(\.|$|[\\/])/.test(raw)) return true; // 8.3 short-name component
  return false;
}

/** Every path-like value this tool call would touch. Unknown shapes yield [] -> denied. */
function extractPaths(toolInput) {
  if (!toolInput || typeof toolInput !== 'object') return [];
  const found = [];
  for (const key of PATH_KEYS) {
    const value = toolInput[key];
    if (typeof value === 'string' && value !== '') found.push(value);
    else if (value !== undefined && value !== null) return []; // non-string path -> unknown shape
  }
  return found;
}

/**
 * realpath requires the file to exist; resolve the deepest existing ancestor then rejoin the
 * remaining segments so both existing and not-yet-created paths are covered. Returns null on
 * any filesystem error so the caller can fail closed rather than fall back to a lexical guess.
 */
function resolveMaybeMissing(projectRoot, p) {
  let abs;
  try {
    abs = path.resolve(projectRoot, p);
  } catch {
    return null;
  }
  let dir = abs;
  const remaining = [];
  for (;;) {
    try {
      const real = fs.realpathSync(dir);
      return path.join(real, ...remaining.reverse());
    } catch (err) {
      if (err && err.code !== 'ENOENT' && err.code !== 'ENOTDIR') return null;
      remaining.push(path.basename(dir));
      const parent = path.dirname(dir);
      if (parent === dir) return abs; // reached filesystem root; nothing on this path exists
      dir = parent;
    }
  }
}

function denyPayload(reason) {
  return `${JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  })}\n`;
}

function deny(reason) {
  process.stdout.write(denyPayload(reason));
  return 0; // the deny decision is what blocks; exit 0 keeps it a clean decision, not an error
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  return raw ? JSON.parse(raw) : {};
}

export async function main() {
  let event;
  try {
    event = await readStdin();
  } catch (err) {
    return deny(`Room-scoping guard: could not parse the hook payload (${err.message}); failing closed.`);
  }

  const roomId = process.env.ROOM_ID;
  if (!roomId) return 0; // not a room-spawned process — allow, no-op

  const toolName = typeof event?.tool_name === 'string' ? event.tool_name : '';
  if (!toolName) return deny('Room-scoping guard: hook payload carried no tool_name; failing closed.');

  if (FORBIDDEN_TOOLS.has(toolName)) {
    return deny(`Room-scoping guard: room ${roomId} may not use ${toolName}. Only file access within room/${roomId}/artifacts/ is permitted.`);
  }

  const isWrite = WRITE_TOOLS.has(toolName);
  const isRead = READ_TOOLS.has(toolName);
  const isSearch = SEARCH_TOOLS.has(toolName);
  if (!isWrite && !isRead && !isSearch) return 0; // no filesystem reach — nothing to scope

  const targets = extractPaths(event?.tool_input);
  if (targets.length === 0) {
    return deny(
      `Room-scoping guard: ${toolName} supplied no recognizable path, so it cannot be confined to ` +
        `room/${roomId}/artifacts/. Pass an explicit path inside that directory.`
    );
  }

  // `cwd` is attacker-adjacent (it arrives in the hook payload), so anchor on this file's own
  // location instead: <SYSTEM_ROOT>/.claude/hooks/guard-room.mjs -> SYSTEM_ROOT.
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const allowedRoot = path.join(projectRoot, 'room', roomId, 'artifacts');
  let realAllowedRoot = allowedRoot;
  try {
    if (fs.existsSync(allowedRoot)) realAllowedRoot = fs.realpathSync(allowedRoot);
  } catch {
    return deny(`Room-scoping guard: could not resolve room/${roomId}/artifacts/; failing closed.`);
  }

  for (const target of targets) {
    if (hasUnsafeSpelling(target)) {
      return deny(`Room-scoping guard: path spelling "${target}" is not accepted (UNC, extended-length, or short-name form).`);
    }
    // Lexical check first — `..` segments are resolved arithmetically, no filesystem access.
    let intended;
    try {
      intended = path.resolve(projectRoot, target);
    } catch {
      return deny(`Room-scoping guard: path "${target}" could not be resolved; failing closed.`);
    }
    if (!isWithin(intended, allowedRoot)) {
      return deny(
        `Room-scoping guard: room ${roomId} may only ${toolName} within room/${roomId}/artifacts/. ` +
          `Target "${target}" resolves to "${intended}", outside that boundary.`
      );
    }
    // Then realpath, to catch a symlink planted inside the room's own artifacts dir that
    // points back out of it.
    const resolved = resolveMaybeMissing(projectRoot, target);
    if (resolved === null) {
      return deny(`Room-scoping guard: could not resolve "${target}" on disk; failing closed.`);
    }
    if (!isWithin(resolved, realAllowedRoot)) {
      return deny(
        `Room-scoping guard: room ${roomId} may only ${toolName} within room/${roomId}/artifacts/. ` +
          `Resolved target "${resolved}" is outside that boundary.`
      );
    }
  }
  return 0;
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      // Fail closed: emit a deny decision AND exit 2, the only exit code PreToolUse treats
      // as blocking. A bare non-zero exit here would let the tool call through.
      process.stdout.write(denyPayload(`Room-scoping guard crashed (${err?.message ?? err}); failing closed.`));
      process.stderr.write(`guard-room hook failed: ${err?.message ?? err}\n`);
      process.exitCode = 2;
    });
}
