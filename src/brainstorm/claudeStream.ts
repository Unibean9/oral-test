import { LIMITS, isPhaseKey } from './contracts.js';

export interface PrivateState { phase: string; technique: string | null; diagnosis: string | null; trace_entry: string | null; }
export interface SplitResult { text: string; state: PrivateState; }

// The state delimiter is deliberately non-Markdown: it is unambiguous and cannot be emitted to SSE.
export const STATE_OPEN = '<brainstorm-private-state>';
export const STATE_CLOSE = '</brainstorm-private-state>';

/** Holds a possible delimiter suffix so private state can never enter a public text delta. */
export class PrivateStateStreamSplitter {
  private full = '';
  private emitted = 0;

  get content() { return this.full; }

  push(delta: string): string {
    this.full += delta;
    if (Buffer.byteLength(this.full, 'utf8') > LIMITS.assistantTextBytes + LIMITS.streamRecordBytes) throw new Error('assistant_output_too_large');
    const stateStart = this.full.indexOf(STATE_OPEN);
    const safeEnd = stateStart >= 0 ? stateStart : Math.max(0, this.full.length - (STATE_OPEN.length - 1));
    if (safeEnd <= this.emitted) return '';
    const publicDelta = this.full.slice(this.emitted, safeEnd);
    this.emitted = safeEnd;
    return publicDelta;
  }

  finish(): SplitResult { return splitFinalPrivateState(this.full); }
}

export function splitFinalPrivateState(input: string): SplitResult {
  if (Buffer.byteLength(input, 'utf8') > LIMITS.assistantTextBytes + LIMITS.streamRecordBytes) throw new Error('assistant_output_too_large');
  const start = input.indexOf(STATE_OPEN);
  if (start < 0 || input.indexOf(STATE_OPEN, start + STATE_OPEN.length) >= 0) throw new Error('missing_or_multiple_private_state');
  const end = input.indexOf(STATE_CLOSE, start + STATE_OPEN.length);
  if (end < 0 || input.slice(end + STATE_CLOSE.length).trim()) throw new Error('malformed_private_state');
  const text = input.slice(0, start).trim();
  let parsed: unknown;
  try { parsed = JSON.parse(input.slice(start + STATE_OPEN.length, end).trim()); } catch { throw new Error('invalid_private_state_json'); }
  if (!parsed || typeof parsed !== 'object') throw new Error('invalid_private_state');
  const value = parsed as Record<string, unknown>;
  if (typeof value.phase !== 'string' || !isPhaseKey(value.phase)) throw new Error('invalid_private_state_phase');
  for (const key of ['technique', 'diagnosis', 'trace_entry']) if (value[key] !== null && typeof value[key] !== 'string') throw new Error('invalid_private_state');
  return { text, state: { phase: value.phase, technique: value.technique as string | null, diagnosis: value.diagnosis as string | null, trace_entry: value.trace_entry as string | null } };
}
