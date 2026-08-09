import { v4 as uuidv4 } from 'uuid';
import { db } from './connection.js';

export interface QuestionRow {
  question_id: string;
  session_id: string;
  slot_id: string;
  chapter_id: string;
  clo_id: string;
  bloom_level: string;
  source_chunk_ids: string; // JSON array of chunk_id
  question_text: string;
  prompt_version: string;
  model_version: string;
  created_at: string;
}

const insertQuestion = db.prepare(
  `INSERT INTO questions
   (question_id, session_id, slot_id, chapter_id, clo_id, bloom_level, source_chunk_ids, question_text, prompt_version, model_version, created_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
);
export function createQuestion(params: {
  sessionId: string; slotId: string; chapterId: string; cloId: string; bloomLevel: string;
  sourceChunkIds: string[]; questionText: string; promptVersion: string; modelVersion: string;
}): QuestionRow {
  const questionId = uuidv4();
  const now = new Date().toISOString();
  const sourceChunkIdsJson = JSON.stringify(params.sourceChunkIds);
  insertQuestion.run(
    questionId, params.sessionId, params.slotId, params.chapterId, params.cloId, params.bloomLevel,
    sourceChunkIdsJson, params.questionText, params.promptVersion, params.modelVersion, now,
  );
  return {
    question_id: questionId, session_id: params.sessionId, slot_id: params.slotId, chapter_id: params.chapterId,
    clo_id: params.cloId, bloom_level: params.bloomLevel, source_chunk_ids: sourceChunkIdsJson,
    question_text: params.questionText, prompt_version: params.promptVersion, model_version: params.modelVersion,
    created_at: now,
  };
}

const selectById = db.prepare('SELECT * FROM questions WHERE question_id = ?');
export function getQuestion(questionId: string): QuestionRow | undefined {
  return selectById.get(questionId) as QuestionRow | undefined;
}

const selectBySession = db.prepare('SELECT * FROM questions WHERE session_id = ? ORDER BY created_at ASC');
export function listQuestionsForSession(sessionId: string): QuestionRow[] {
  return selectBySession.all(sessionId) as QuestionRow[];
}

const insertTurn = db.prepare(
  `INSERT INTO oral_turns (turn_id, question_id, input_mode, text, created_at) VALUES (?, ?, ?, ?, ?)`,
);
export interface OralTurnRow {
  turn_id: string;
  question_id: string;
  input_mode: 'stt' | 'typed';
  text: string;
  created_at: string;
}
export function createOralTurn(params: { questionId: string; inputMode: 'stt' | 'typed'; text: string }): OralTurnRow {
  const turnId = uuidv4();
  const now = new Date().toISOString();
  insertTurn.run(turnId, params.questionId, params.inputMode, params.text, now);
  return { turn_id: turnId, question_id: params.questionId, input_mode: params.inputMode, text: params.text, created_at: now };
}

const selectTurnsByQuestion = db.prepare('SELECT * FROM oral_turns WHERE question_id = ? ORDER BY created_at ASC');
export function listTurnsForQuestion(questionId: string): OralTurnRow[] {
  return selectTurnsByQuestion.all(questionId) as OralTurnRow[];
}

// Joins through questions so a single query returns every turn belonging to a session, without
// the caller looping per-question — used by the review snapshot builder (Phase 5).
const selectTurnsBySession = db.prepare(`
  SELECT oral_turns.* FROM oral_turns
  JOIN questions ON questions.question_id = oral_turns.question_id
  WHERE questions.session_id = ?
  ORDER BY oral_turns.created_at ASC
`);
export function listTurnsForSession(sessionId: string): OralTurnRow[] {
  return selectTurnsBySession.all(sessionId) as OralTurnRow[];
}
