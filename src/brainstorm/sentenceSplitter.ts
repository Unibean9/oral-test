const TERMINATORS = /[.!?…]/;
const CLOSERS = /["')\]»*]/; // closing characters that can sit between the terminator and whitespace, e.g. "thanks." " — still a boundary
const MIN_SENTENCE_CHARS = 8;
const MAX_SENTENCE_CHARS = 220; // force a flush if no terminator is found, so audio is never delayed indefinitely

/**
 * Vietnamese abbreviations whose trailing period is not a sentence end. Without these,
 * "TP. Hồ Chí Minh" splits across two TTS calls with an audible prosody break in the middle,
 * and "v.v." fragments into sub-MIN_SENTENCE_CHARS pieces that glue onto the preceding text.
 * Matched case-insensitively against the word immediately before the period.
 */
const ABBREVIATIONS = new Set(['tp', 'v', 'vd', 'vv', 'ths', 'ts', 'gs', 'pgs', 'ks', 'bs', 'st', 'tt', 'q', 'p']);
const WORD_BEFORE_PERIOD = /([\p{L}\p{N}]+)$/u;
/** A run of single letters separated by dots, e.g. the "v.v" preceding the closing dot of "v.v.". */
const MULTI_DOT_ABBREV = /(?:\p{L}\.)+\p{L}$/u;

export class SentenceSplitter {
  private buffer = '';

  push(delta: string): string[] {
    this.buffer += delta;
    const sentences: string[] = [];
    let scanFrom = 0;
    for (;;) {
      const boundary = this.findBoundary(scanFrom);
      if (boundary < 0) break;
      const candidate = this.buffer.slice(0, boundary + 1).trim();
      if (candidate.length >= MIN_SENTENCE_CHARS) {
        sentences.push(candidate);
        this.buffer = this.buffer.slice(boundary + 1);
        scanFrom = 0;
      } else {
        scanFrom = boundary + 1;
      }
    }
    this.forceFlush(sentences);
    return sentences.filter(Boolean);
  }

  finish(): string[] {
    const out: string[] = [];
    this.forceFlush(out);
    const tail = this.buffer.trim();
    this.buffer = '';
    if (tail) out.push(tail);
    return out;
  }

  /** Shared by push() and finish() — these two loops were byte-identical duplicates. */
  private forceFlush(out: string[]): void {
    while (this.buffer.length > MAX_SENTENCE_CHARS) {
      const at = this.safeCutPoint();
      out.push(this.buffer.slice(0, at).trim());
      this.buffer = this.buffer.slice(at);
    }
  }

  /**
   * Where to cut a run of text with no sentence terminator in it. Prefers the last whitespace
   * character, then backs off a code unit if that would land inside a surrogate pair — a blind
   * slice at MAX_SENTENCE_CHARS can split an emoji, and the resulting lone surrogate reaches
   * both TTS and the SSE text as U+FFFD.
   */
  private safeCutPoint(): number {
    let at = MAX_SENTENCE_CHARS;
    // Any Unicode whitespace, not just U+0020: text using U+00A0 or ideographic spacing
    // otherwise degraded to the blind code-unit cut below.
    for (let i = MAX_SENTENCE_CHARS; i > MIN_SENTENCE_CHARS; i -= 1) {
      if (/\s/.test(this.buffer[i])) { at = i; break; }
    }
    const code = this.buffer.charCodeAt(at);
    if (code >= 0xdc00 && code <= 0xdfff) at -= 1; // low surrogate: step back before its high half
    return Math.max(1, at);
  }

  /** True when the period at `index` closes a known abbreviation rather than a sentence. */
  private isAbbreviation(index: number): boolean {
    const before = this.buffer.slice(0, index);
    const match = WORD_BEFORE_PERIOD.exec(before);
    if (!match || !ABBREVIATIONS.has(match[1].toLowerCase())) return false;
    // "v.v." / "tp.hcm." style: a run of single letters separated by dots. At the SECOND dot the
    // preceding slice ends "…v.v", and '.' is outside [\p{L}\p{N}], so WORD_BEFORE_PERIOD captured
    // just "v" — which is in ABBREVIATIONS. The abbreviation's own terminating period was
    // therefore skipped and the next sentence was glued into the same chunk, roughly doubling the
    // first chunk and so the time-to-first-audio that streaming mode exists to minimise.
    if (MULTI_DOT_ABBREV.test(before)) {
      // A dotted run already closed by this period ends a sentence when what follows starts a new
      // one. Deliberate limitation: this cannot distinguish "v.v. Sau đó…" from a hypothetical
      // "v.v. Hà Nội…" where a capitalised proper noun continues the same sentence. The
      // uppercase-follows heuristic is the standard trade and errs toward more, shorter chunks —
      // the safe direction for TTS latency. Single-dot cases like "TP. Hồ Chí Minh" never reach
      // here, because the text before that period is not a dotted run.
      if (/^\s+\p{Lu}/u.test(this.buffer.slice(index + 1))) return false;
    }
    return true;
  }

  private findBoundary(from: number): number {
    for (let i = from; i < this.buffer.length; i++) {
      if (!TERMINATORS.test(this.buffer[i])) continue;
      const afterTerminator = this.buffer[i + 1];
      if (afterTerminator !== undefined && /\d/.test(afterTerminator)) continue; // "3.5", "1.000" guard
      if (this.buffer[i] === '.' && this.isAbbreviation(i)) continue;
      let j = i + 1;
      while (j < this.buffer.length && CLOSERS.test(this.buffer[j])) j++; // skip over closing characters
      const next = this.buffer[j];
      if (next === undefined) continue; // not enough data yet to be sure — wait for the next delta or finish()
      if (!/\s/.test(next)) continue;
      return j - 1;
    }
    return -1;
  }
}
