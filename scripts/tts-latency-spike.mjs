#!/usr/bin/env node
// Standalone measurement spike for plans/260809-2300-restore-oral-tts-sse. Not part of
// `npm test` (never require a live model to run the suite) and not shipped (tsc's `include` is
// scoped to `src/`, so this file never reaches `out/` via `npm run compile`).
//
// Measures, against a real (or faithfully local) tts-sidecar `/synthesize/stream`:
//   - whole-question synthesis vs. per-sentence synthesis: which reaches first-audio faster
//   - the audio framing contract: is each streamed frame an independently playable WAV file
//   - baseline cold/warm latency numbers on the machine actually running the sidecar
//
// Usage:
//   node scripts/tts-latency-spike.mjs [--base-url http://127.0.0.1:8765] [--runs 5]

import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
function argValue(flag, fallback) {
  const idx = args.indexOf(flag);
  return idx === -1 ? fallback : args[idx + 1];
}
const BASE_URL = argValue('--base-url', process.env.TTS_SIDECAR_URL ?? 'http://127.0.0.1:8765');
const RUNS = Number(argValue('--runs', '5'));
const VOICE_ID = 'vi-female-01'; // DEFAULT_VOICE_ID per tts-sidecar/app.py

const TAG_AUDIO = 0x00, TAG_END_OK = 0x01, TAG_END_ERROR = 0x02, TAG_BUSY = 0x03;

// Hand-rolled for this spike only — this script has no dependency on the production TTS module.
function splitSentences(text) {
  const parts = text.split(/(?<=[.!?…])\s+(?=[A-ZÀ-Ỹ])/u).map((s) => s.trim()).filter(Boolean);
  return parts.length > 0 ? parts : [text];
}

const QUESTIONS = {
  short: 'Anh chị hãy trình bày định nghĩa của khái niệm này.',
  long: [
    'Anh chị hãy trình bày định nghĩa của khái niệm điện trở suất trong vật lý học.',
    'Sau đó, hãy nêu một ví dụ thực tế minh họa cho khái niệm này tại TP. Hồ Chí Minh.',
    'Cuối cùng, hãy giải thích mối liên hệ giữa điện trở suất và nhiệt độ của vật liệu dẫn điện.',
  ].join(' '),
};

/** Reads one /synthesize/stream response to completion, timing each milestone. */
async function readStream(response, onFrame) {
  const sentAt = performance.now();
  const reader = response.body.getReader();
  let firstByteAt = null;
  let firstFrameAt = null;
  let pending = Buffer.alloc(0);
  let frameCount = 0;
  let terminator = null;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (firstByteAt === null) firstByteAt = performance.now();
      pending = Buffer.concat([pending, Buffer.from(value)]);
      for (;;) {
        if (pending.length < 1) break;
        const tag = pending[0];
        if (tag === TAG_END_OK || tag === TAG_END_ERROR || tag === TAG_BUSY) {
          terminator = tag;
          pending = pending.subarray(1);
          break;
        }
        if (tag !== TAG_AUDIO) throw new Error(`unknown frame tag ${tag}`);
        if (pending.length < 5) break;
        const frameLen = pending.readUInt32BE(1);
        if (pending.length < 5 + frameLen) break;
        const frame = pending.subarray(5, 5 + frameLen);
        frameCount += 1;
        if (firstFrameAt === null) firstFrameAt = performance.now();
        onFrame(frame, frameCount);
        pending = pending.subarray(5 + frameLen);
      }
      if (terminator !== null) break;
    }
  } finally {
    try { await reader.cancel(); } catch { /* best-effort */ }
  }
  const endAt = performance.now();
  return {
    sentAt, firstByteAt, firstFrameAt, endAt, frameCount, terminator,
    firstByteMs: firstByteAt !== null ? firstByteAt - sentAt : null,
    firstFrameMs: firstFrameAt !== null ? firstFrameAt - sentAt : null,
    totalMs: endAt - sentAt,
  };
}

async function synthesizeOnce(text, { dumpFirstFrameTo } = {}) {
  const response = await fetch(`${BASE_URL}/synthesize/stream`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text, voice_id: VOICE_ID }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`sidecar returned ${response.status}: ${body}`);
  }
  let dumped = false;
  return readStream(response, (frame) => {
    if (dumpFirstFrameTo && !dumped) {
      writeFileSync(dumpFirstFrameTo, frame);
      dumped = true;
    }
  });
}

/** Runs the whole-question variant: one /synthesize/stream call for the full text. */
async function runWhole(text, dumpFirstFrameTo) {
  const result = await synthesizeOnce(text, { dumpFirstFrameTo });
  return { firstFrameMs: result.firstFrameMs, totalMs: result.totalMs, terminator: result.terminator };
}

/** Runs the per-sentence variant: sequential /synthesize/stream calls, one per sentence, timing
 * from the very first call's send to the very first sentence's first frame (that is what
 * time-to-first-audio actually means for a client waiting to start playback), and to the last
 * sentence's stream end for total. */
async function runPerSentence(text, dumpFirstFrameTo) {
  const sentences = splitSentences(text);
  const overallStart = performance.now();
  let firstFrameMs = null;
  for (let i = 0; i < sentences.length; i += 1) {
    const result = await synthesizeOnce(sentences[i], { dumpFirstFrameTo: i === 0 ? dumpFirstFrameTo : undefined });
    if (i === 0 && result.firstFrameMs !== null) {
      firstFrameMs = (performance.now() - overallStart) - (result.totalMs - result.firstFrameMs);
    }
    if (result.terminator !== TAG_END_OK) throw new Error(`sentence ${i} ended with terminator 0x${result.terminator?.toString(16)}`);
  }
  const totalMs = performance.now() - overallStart;
  return { firstFrameMs, totalMs, terminator: TAG_END_OK, sentenceCount: sentences.length };
}

function stats(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;
  const p50 = sorted[Math.floor(sorted.length * 0.5)];
  const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
  return { mean, p50, p95 };
}

async function main() {
  console.log(`tts-latency-spike: base=${BASE_URL} runs=${RUNS}`);
  const health = await fetch(`${BASE_URL}/health`).catch(() => null);
  if (!health || !health.ok) {
    console.error(`sidecar not reachable at ${BASE_URL}/health — start it per tts-sidecar/README.md first.`);
    console.error('This script cannot produce real numbers without a live sidecar; see tts-latency-spike-RESULTS.md for how this gap was handled.');
    process.exitCode = 1;
    return;
  }
  const healthBody = await health.json();
  console.log('sidecar health:', healthBody);

  const results = {};
  for (const [label, text] of Object.entries(QUESTIONS)) {
    for (const [variant, runFn] of [['whole', runWhole], ['per-sentence', runPerSentence]]) {
      const key = `${label}/${variant}`;
      const firstFrameSamples = [];
      const totalSamples = [];
      for (let i = 0; i < RUNS; i += 1) {
        const dumpPath = i === 0 ? path.join(__dirname, `tts-spike-frame-${label}-${variant}.wav`) : undefined;
        try {
          const r = await runFn(text, dumpPath);
          if (r.firstFrameMs !== null) firstFrameSamples.push(r.firstFrameMs);
          totalSamples.push(r.totalMs);
        } catch (err) {
          console.error(`  [${key}] run ${i} failed:`, err.message);
        }
      }
      results[key] = { firstFrame: stats(firstFrameSamples), total: stats(totalSamples) };
    }
  }

  console.log('\nResults (ms):');
  console.log('variant'.padEnd(24), 'first-frame p50/p95'.padEnd(24), 'total p50/p95');
  for (const [key, r] of Object.entries(results)) {
    console.log(
      key.padEnd(24),
      `${r.firstFrame.p50?.toFixed(0) ?? 'n/a'}/${r.firstFrame.p95?.toFixed(0) ?? 'n/a'}`.padEnd(24),
      `${r.total.p50?.toFixed(0) ?? 'n/a'}/${r.total.p95?.toFixed(0) ?? 'n/a'}`,
    );
  }
  console.log(`\nFirst frame of each variant's first run dumped under ${__dirname} as tts-spike-frame-*.wav.`);
  console.log('Play (or ffprobe) each one individually to confirm it is a complete, independently valid WAV file.');
}

await main();
