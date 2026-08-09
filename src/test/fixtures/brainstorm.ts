import { v4 as uuidv4 } from 'uuid';
import { createOrLoadOperation, markOperationProcessing, finalizeOperation } from '../../db/sessions.js';

export const PRIVATE_STATE = '<brainstorm-private-state>{"phase":"framing","technique":"5W1H","diagnosis":"need a shared frame","trace_entry":"The group named the problem."}</brainstorm-private-state>';
export const PUBLIC_REPLY = 'Cả nhóm hãy cùng xác định điều cần giải quyết trước.';
export const VALID_REPLY = `${PUBLIC_REPLY}${PRIVATE_STATE}`;

// Sanitized stream-json samples. They are intentionally provider-free so stream/parser tests
// never need a Claude account or a real child process.
export const VALID_STREAM_JSON_LINES = [
  JSON.stringify({ type: 'content_block_delta', delta: { text: PUBLIC_REPLY.slice(0, 18) } }),
  JSON.stringify({ type: 'content_block_delta', delta: { text: `${PUBLIC_REPLY.slice(18)}${PRIVATE_STATE}` } }),
  JSON.stringify({ type: 'result', result: VALID_REPLY }),
];

export const MALFORMED_STREAM_JSON_LINES = [
  JSON.stringify({ type: 'content_block_delta', delta: { text: PUBLIC_REPLY } }),
  JSON.stringify({ type: 'result', result: `${PUBLIC_REPLY}<brainstorm-private-state>{}` }),
];

export const WAV_FIXTURE = Buffer.concat([
  Buffer.from('RIFF'),
  Buffer.alloc(4),
  Buffer.from('WAVE'),
  Buffer.alloc(28),
]);

export const SESSION_ID = '6b2b6eb1-5358-4cac-80ee-fab6dc917e8f';
export const CLIENT_TURN_ID = 'fixture-turn-1';

/**
 * Seeds one user+facilitator exchange through the PRODUCTION write path
 * (createOrLoadOperation -> markOperationProcessing -> finalizeOperation) instead of duplicating
 * that logic in a test-only writer. Using the real path means a future drift between test
 * fixtures and production persistence shows up as a failing test, not as silent divergence.
 */
export function seedExchange(params: {
  sessionId: string;
  userText: string;
  facilitatorText: string;
  phase: string;
  technique: string | null;
  diagnosis: string | null;
  traceEntry: string | null;
  clientTurnId?: string;
}): { turnId: string; turnIndex: number; assistantMessageId: string } {
  const { operation } = createOrLoadOperation(
    params.sessionId,
    params.clientTurnId ?? `fixture-${uuidv4()}`,
    params.userText,
  );
  markOperationProcessing(operation.turn_id);
  const assistantMessageId = finalizeOperation({
    operation,
    text: params.facilitatorText,
    phase: params.phase,
    technique: params.technique,
    diagnosis: params.diagnosis,
    traceEntry: params.traceEntry,
    finalSeq: 1,
  });
  return { turnId: operation.turn_id, turnIndex: operation.turn_index, assistantMessageId };
}
