/**
 * Deterministic extraction of the guard rails a sell-side prompt's `doNotClaim` block carries.
 * `prd.md` has a machine-readable format `src/prd/generate.ts` mandates character for character,
 * so this guidance does not have to be left entirely to the model — `src/brief/lint.ts` does not
 * re-check compliance; this is guidance in the prompt, not a runtime enforcement.
 *
 * Every function here is best-effort: a PRD that does not match the expected shape yields empty
 * arrays and the model-authored output stands alone — a malformed PRD must never block artifact
 * generation, so nothing in this file throws.
 */
import fs from 'node:fs';
import path from 'node:path';
import { roomArtifactsDir } from '../artifacts/paths.js';

export interface PrdFacts {
  /** §5 feature names whose `- **Ưu tiên:**` line is P1 or P2. */
  deprioritisedFeatures: string[];
  /** Headings whose body carries the literal `[Giả định]` marker. */
  assumedSections: string[];
  /** §9 bullets containing `Câu hỏi mở`. */
  openQuestions: string[];
  /**
   * Non-fatal notes about what could not be extracted. Never blocks generation — see the module
   * comment — but it must be visible, because a silent `[]` is indistinguishable from a genuinely
   * empty PRD. Carries heading tokens and fixed prose only, never a raw PRD line: this text reaches
   * log lines and response bodies, and the PRD is derived from group speech.
   */
  parseWarnings: string[];
}

// `\.?` accepts `### 5.1. Tên` as well as the `### 5.1 Tên` that src/prd/generate.ts specifies.
// HARDENING, not a bug fix: the only PRD in the repo writes the dotless form, so the drifted
// spelling has never actually been observed. The load-bearing half of this fix is parseWarnings
// below, which makes the parser fail loudly whichever spelling arrives.
const FEATURE_HEADING_RE = /^###\s+5\.\d+\.?\s+(.+?)\s*$/;
const ANY_HEADING_RE = /^(#{1,6})\s+(.+?)\s*$/;
const PRIORITY_RE = /^\s*-\s*\*\*Ưu tiên:\*\*\s*(.+?)\s*$/;
const ASSUMED_MARKER = '[Giả định]';
const OPEN_QUESTION_MARKER = 'Câu hỏi mở';

const SECTION_5_HEADING_RE = /^##\s+5\.\s/;

export function parsePrdFacts(prdMarkdown: string): PrdFacts {
  const empty = (): PrdFacts => ({ deprioritisedFeatures: [], assumedSections: [], openQuestions: [], parseWarnings: [] });
  if (typeof prdMarkdown !== 'string' || prdMarkdown.trim() === '') return empty();

  const parseWarnings: string[] = [];
  const warn = (note: string): void => { parseWarnings.push(note); console.warn(`[prd-facts] ${note}`); };
  try {
    const lines = prdMarkdown.split(/\r?\n/);
    const deprioritisedFeatures: string[] = [];
    const assumedSections: string[] = [];
    const openQuestions: string[] = [];
    let sawSection5 = false;
    let featureBlocks = 0;
    const featuresWithoutPriority = new Set<string>();

    // The heading a line belongs to, and — separately — the §5 feature block it belongs to. They
    // are tracked apart because a feature block is also a heading, and the priority line must be
    // attributed to its own feature rather than to whatever heading came last.
    let currentHeading: string | null = null;
    let currentFeature: string | null = null;
    let inSection9 = false;

    for (const line of lines) {
      const heading = ANY_HEADING_RE.exec(line);
      if (heading) {
        currentHeading = heading[2];
        if (SECTION_5_HEADING_RE.test(line)) sawSection5 = true;
        const feature = FEATURE_HEADING_RE.exec(line);
        currentFeature = feature ? feature[1] : null;
        if (currentFeature) { featureBlocks += 1; featuresWithoutPriority.add(currentFeature); }
        // §9 ends at the next h2, which in this document's fixed heading order means it runs to
        // the end of the file — but scoping it explicitly keeps the parser correct if a later
        // section is ever appended.
        if (heading[1].length === 2) inSection9 = /^9\.\s/.test(heading[2]);
        continue;
      }

      const priority = currentFeature ? PRIORITY_RE.exec(line) : null;
      if (priority && currentFeature) {
        featuresWithoutPriority.delete(currentFeature);
        // The demo PRD's own §5.5 reads "P2 (nhóm đề xuất có thể bỏ qua)", so match the token
        // anywhere in the value rather than requiring the whole line to equal it.
        if (/\bP[12]\b/.test(priority[1]) && !deprioritisedFeatures.includes(currentFeature)) {
          deprioritisedFeatures.push(currentFeature);
        }
        continue;
      }

      // §9 is skipped deliberately: it is BY DEFINITION the register of every derived block, so
      // every one of its bullets carries the marker. Recording it would emit the self-referential
      // instruction "the content of §9 Assumptions is an assumption", which is noise in a list
      // whose every line has to be reproduced verbatim downstream.
      if (!inSection9 && line.includes(ASSUMED_MARKER) && currentHeading && !assumedSections.includes(currentHeading)) {
        assumedSections.push(currentHeading);
      }
      if (inSection9 && /^\s*[-*]\s/.test(line) && line.includes(OPEN_QUESTION_MARKER)) {
        openQuestions.push(line.replace(/^\s*[-*]\s*/, '').trim());
      }
    }

    // One summary note per condition, not one line per feature — per-feature detail adds
    // nothing a teacher or log reader could act on differently.
    if (!sawSection5) warn('no "## 5." heading found; the deprioritised-feature guard rail is disabled for this PRD');
    else if (featureBlocks === 0) warn('"## 5." has no "### 5.x <name>" sub-block; the deprioritised-feature guard rail is disabled for this PRD');
    else if (featuresWithoutPriority.size > 0) warn(`${featuresWithoutPriority.size} §5 feature block(s) have no "- **Ưu tiên:**" line`);

    return { deprioritisedFeatures, assumedSections, openQuestions, parseWarnings };
  } catch (err) {
    // Defensive: a malformed PRD must degrade to "no deterministic guard rails", never to a
    // failed export at the end of a workshop. It must no longer degrade SILENTLY, though — a bare
    // `[]` was indistinguishable from a PRD that genuinely set nothing aside.
    warn(`parser threw, returning no guard rails: ${(err as Error)?.message ?? 'unknown error'}`);
    return { ...empty(), parseWarnings };
  }
}

/**
 * Renders the extracted facts as Vietnamese instruction lines, fed to the sell-side route prompts
 * as `doNotClaim` guidance (see `routes/sessionArtifacts.ts`'s `sourcePreamble`). No lint pass
 * re-checks feature names against the generated artifacts — this wording is prompt guidance only,
 * never machine-enforced.
 */
export function forbiddenClaims(facts: PrdFacts): string[] {
  const lines: string[] = [];
  for (const feature of facts.deprioritisedFeatures) {
    lines.push(
      `"${feature}" là hướng ĐÃ BỊ LÙI ƯU TIÊN — không được trình bày như tính năng đang có.`,
    );
  }
  for (const question of facts.openQuestions) {
    lines.push(`Chưa có câu trả lời cho câu hỏi mở sau, không được nói như đã chốt: ${question}`);
  }
  for (const section of facts.assumedSections) {
    lines.push(`Nội dung ở "${section}" là suy luận, không phải điều nhóm đã khẳng định — không được trình bày như dữ kiện.`);
  }
  return lines;
}

/** The deterministic forbidden-claim lines for a session, derived from its own `prd.md`. Shared by
 *  every sell-side route so they all agree on the exact strings. Returns an empty list when the
 *  PRD is missing or unparseable. */
export function forbiddenClaimsFor(sessionId: string): string[] {
  const prdFile = path.join(roomArtifactsDir(sessionId), 'prd.md');
  if (!fs.existsSync(prdFile)) return [];
  try {
    return forbiddenClaims(parsePrdFacts(fs.readFileSync(prdFile, 'utf8')));
  } catch (err) {
    // Logged rather than swallowed: an empty forbidden list silently removes every deterministic
    // guard line, so "this PRD sets nothing aside" and "this PRD could not be read" must not look
    // the same from the outside.
    console.warn(`[prdFacts] ${sessionId}: could not derive forbidden claims from prd.md`, err);
    return [];
  }
}
