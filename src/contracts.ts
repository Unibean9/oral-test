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
  // Absolute cap for one /synthesize/stream call against tts-sidecar.
  ttsTimeoutMs: 90_000,
  // Per-response cap for a student's relayed oral answer, enforced before it reaches the request
  // fingerprint, the DB, or a Claude CLI prompt. A spoken answer transcribed to text is nowhere
  // near this size; this exists to bound cost/latency of a pathological or scripted submission.
  studentAnswerBytes: 8_000,
} as const;

// Drift-check only (src/tts/streamClient.ts's checkVoiceDriftAtBoot) — no per-session voice
// selection; every synthesis uses DEFAULT_VOICE_ID. Ids and labels must match
// tts-sidecar/app.py's VOICE_PRESETS keys exactly.
export const SUPPORTED_VOICES = [
  { id: 'vi-female-01', label: 'Trúc Ly (nữ)' },
  { id: 'vi-male-01', label: 'Phạm Tuyên (nam)' },
] as const;
export const DEFAULT_VOICE_ID: (typeof SUPPORTED_VOICES)[number]['id'] = 'vi-female-01';

// Deliberately avoids a control-char escape regex literal (checked char-code-by-char-code
// instead) - every ASCII control character (codes 0-31) plus DEL (127).
function hasControlChar(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

// Same as hasControlChar but tolerates tab/LF/CR (codes 9/10/13) — needed for multi-line free
// text (a typed or STT-transcribed oral answer) where hasControlChar's single-line policy would
// otherwise reject an ordinary newline.
function hasDisallowedControlChar(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code === 9 || code === 10 || code === 13) continue;
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

// A student's relayed oral answer (submitOralTurn's `text`): the largest untrusted free-text
// field this domain persists and forwards into a Claude prompt via wrapUntrusted(). Enforced at
// the route boundary before the request fingerprint is computed, so an oversized/invalid answer
// is rejected before it reaches the DB or a CLI call — never silently truncated.
export function validateBoundedText(value: unknown, maxBytes: number): string | null {
  if (typeof value !== 'string') return null;
  // Normalized before length/control-char checks so a Windows-style CRLF answer isn't penalized
  // twice for what a reader would consider one line break.
  const trimmed = value.replace(/\r\n/g, '\n').trim();
  if (!trimmed) return null;
  if (byteLength(trimmed) > maxBytes) return null;
  if (hasDisallowedControlChar(trimmed)) return null;
  return trimmed;
}
