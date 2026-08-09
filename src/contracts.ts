// Generic HTTP envelope + validation helpers shared by every route in this API. Originally lived
// under src/brainstorm/ alongside facilitator-specific constants; extracted here when the
// brainstorm/PRD/room product was retired (Phase 6) so this small, still-needed surface didn't
// get deleted along with it.

export function apiOk<T>(data: T, message = 'OK') { return { isSuccess: true, message, data }; }
export function apiError(code: string, message: string, recoverable = false) {
  return { isSuccess: false, message, error: { code, recoverable } };
}

export function byteLength(value: string): number { return Buffer.byteLength(value, 'utf8'); }

export const LIMITS = {
  streamRecordBytes: 256 * 1024,
  // Budget for a live, spoken facilitator turn - retained only because claude-cli/spawn.ts's
  // conversational (non-fresh-session) path still defaults to it.
  claudeTimeoutMs: 120_000,
  // Budget for one-shot fresh-session invocations (oral-examiner, oral-assessment-reviewer).
  claudeArtifactTimeoutMs: 300_000,
  nameBytes: 200,
} as const;

// Deliberately avoids a control-char escape regex literal (checked char-code-by-char-code
// instead) - every ASCII control character (codes 0-31) plus DEL (127).
function hasControlChar(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

// The first free-text, user-supplied, persisted field in this system (teachers.name). Rejects
// control characters because these values are written into cloud JSON a teacher reads and could
// later be interpolated into a Claude prompt - always go through wrapUntrusted() if that ever
// happens, never interpolate raw.
export function validateName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (byteLength(trimmed) > LIMITS.nameBytes) return null;
  if (hasControlChar(trimmed)) return null;
  return trimmed;
}
