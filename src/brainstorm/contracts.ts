import { validate as isUuid } from 'uuid';

export const API_PREFIX = '/api/v1/brainstorm';
// Identification, not authentication — see brainstorm/teacherContext.ts. Anyone who can reach
// the loopback port can send any value; this labels attribution, it proves nothing.
export const TEACHER_HEADER = 'x-teacher-id';
export const ROOM_ID_PREFIX = 'rm_';
export const PHASE_KEYS = ['framing', 'diverging', 'shifting', 'critiquing', 'converging', 'wrap-up'] as const;
export const ENGINE_NODES = ['observer', 'analyzer', 'diagnosis', 'thinking-state', 'technique', 'facilitate', 'trace', 'insight'] as const;

export interface VoiceOption { id: string; label: string }
// Repo-owned ids — never a passthrough of vieneu's internal preset names. These must equal the
// keys of VOICE_PRESETS in tts-sidecar/app.py, and may not contain `_` because
// assets/fillers/ filenames use `_` as a field delimiter.
export const SUPPORTED_VOICES: readonly VoiceOption[] = [
  { id: 'vi-female-01', label: 'Giọng nữ' },
  { id: 'vi-male-01', label: 'Giọng nam' },
];
export const DEFAULT_VOICE_ID = SUPPORTED_VOICES[0].id;
const VOICE_ID_RE = /^[a-z0-9-]{1,32}$/;
// 'streaming' (default): sentence-by-sentence TTS via `/synthesize/stream` as the reply is
// generated — lowest latency to first audio.
// 'text': skip TTS entirely. Kept deliberately (not YAGNI-eligible): it is the only way to run a
// turn without touching the TTS sidecar at all, which is what keeps `npm test` deterministic and
// network-free — most of the suite's turn payloads use it for exactly that reason.
export const AUDIO_MODES = ['streaming', 'text'] as const;
export type AudioMode = (typeof AUDIO_MODES)[number];
export const LIMITS = {
  textBytes: 12_000,
  clientTurnIdBytes: 128,
  streamRecordBytes: 256 * 1024,
  assistantTextBytes: 128 * 1024,
  wavBytes: 16 * 1024 * 1024,
  // `agent-audio` carries a complete WAV as base64. 16 MiB decoded needs ~22.4 MiB plus
  // envelope overhead, so this remains bounded while allowing the documented maximum.
  sseEventBytes: 24 * 1024 * 1024,
  // Budget for a live, spoken facilitator turn (streamTurn) and the initial room-boot
  // invocation — both are conversational in shape and expected to answer quickly.
  claudeTimeoutMs: 120_000,
  // Budget for one-shot artifact generation (PRD, landing page, pitch deck), not conversational:
  // design-lead briefs run a multi-pass plan/critique/build process authoring a large file in
  // one turn, needing far more wall-clock time than a spoken reply.
  claudeArtifactTimeoutMs: 300_000,
  // Cap for one non-streaming /synthesize call — always a single sentence (SentenceSplitter
  // caps a chunk at 220 chars), not a whole reply. Sidecar measures ~21 chars/sec; the
  // remaining headroom covers a cold or contended model.
  ttsTimeoutMs: 90_000,
  turnAudioBytes: 32 * 1024 * 1024,
  nameBytes: 200,
} as const;

export type PhaseKey = (typeof PHASE_KEYS)[number];
export type OperationStatus = 'accepted' | 'processing' | 'completed' | 'failed' | 'interrupted';
export type PublicState = 'idle' | 'processing' | 'agent-speaking';

export interface PublicMessage {
  messageId: string;
  role: 'user' | 'agent';
  text: string;
  turnId: string;
  replyToMessageId?: string;
  createdAt: string;
}

export interface ActiveTurn {
  turnId: string;
  clientTurnId: string;
  status: OperationStatus;
  userMessageId: string;
  assistantMessageId: string | null;
  lastSeq: number;
}

export function apiOk<T>(data: T, message = 'OK') { return { isSuccess: true, message, data }; }
export function apiError(code: string, message: string, recoverable = false) {
  return { isSuccess: false, message, error: { code, recoverable } };
}

export function byteLength(value: string): number { return Buffer.byteLength(value, 'utf8'); }
export function isPhaseKey(value: string): value is PhaseKey { return (PHASE_KEYS as readonly string[]).includes(value); }

export function isVoiceId(value: string): boolean {
  return SUPPORTED_VOICES.some((v) => v.id === value);
}

// Mirrors validateName's shape (non-string / empty / out-of-allowlist -> null, never throws).
export function validateVoiceId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  if (!VOICE_ID_RE.test(value)) return null;
  return isVoiceId(value) ? value : null;
}

// A room id (`rm_<uuid>`) can never satisfy isUuid, and a bare uuid can never satisfy this —
// the prefix makes the two id spaces non-interchangeable by construction. Never let a room id
// reach artifacts/paths.ts's resolveSafeArtifactPath check.
export function isRoomId(value: string): boolean {
  return typeof value === 'string' && value.startsWith(ROOM_ID_PREFIX) && isUuid(value.slice(ROOM_ID_PREFIX.length));
}

const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f]/;

// The first free-text, user-supplied, persisted field in this system (teachers.name,
// rooms.name, sessions.name). Rejects control characters because these values are written
// into cloud JSON a teacher reads and could later be interpolated into a Claude prompt —
// always go through wrapUntrusted() if that ever happens, never interpolate raw.
export function validateName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (byteLength(trimmed) > LIMITS.nameBytes) return null;
  if (CONTROL_CHAR_RE.test(trimmed)) return null;
  return trimmed;
}
