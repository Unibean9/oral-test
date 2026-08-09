/**
 * Deterministic checks on the FORM of what the design skills emitted — render-capability only,
 * answering one question: *can this file actually be rendered/printed the way the pipeline
 * promises?* No landing-page section contract, word budget, font taste, or CTA rule lives here —
 * a content/taste gate wearing a "structure" label is what used to keep output generic.
 *
 * No Fastify import, no DOM library — pure string/regex work, unit-testable in isolation. Problem
 * strings carry rule ids, indices, counts and expected sets, never matched text: these details are
 * concatenated into the retry prompt without `wrapUntrusted()`, and a `data-slide` value is
 * model-authored text derived from group speech.
 */
import type { LintProblem } from './lint.js';

export const DECK_SLIDE_COUNT = 8;

export interface HookedElement {
  /** The `data-slide` value, verbatim — used for matching only. */
  hook: string;
  position: number;
}

/** Every `<section data-slide="…">`, stack-walked so a nested section cannot break the pairing
 *  between an open tag and its matching close tag. */
export function parseSlides(html: string): HookedElement[] {
  const tagRe = /<section\b([^>]*)>|<\/section\s*>/gi;
  const found: Array<HookedElement & { start: number }> = [];
  const stack: Array<{ openTag: string; start: number }> = [];
  for (const match of html.matchAll(tagRe)) {
    const isOpen = match[0][1] !== '/';
    if (isOpen) { stack.push({ openTag: match[0], start: match.index }); continue; }
    const open = stack.pop();
    if (!open) continue;
    const hookMatch = /\bdata-slide\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(open.openTag);
    const hook = hookMatch ? (hookMatch[2] ?? hookMatch[3] ?? hookMatch[4] ?? '') : null;
    if (hook === null) continue;
    found.push({ hook, position: 0, start: open.start });
  }
  return found.sort((a, b) => a.start - b.start).map(({ start: _start, ...el }, position) => ({ ...el, position }));
}

/**
 * The document shell. Source-level scans on RAW BYTES: a DOM parser synthesises `<html>`/`<head>`
 * for any soup, so a post-parse check would report "present" on a file carrying none of it.
 *
 * HARD, never terminal — a missing shell tag is neither dishonest nor unsafe. `viewport` is
 * landing-only: `deck.html` is rendered by our own Chromium at a `@page`-driven size, where a
 * viewport meta means nothing.
 */
export function lintDocumentShell(html: string, opts: { viewport: boolean }): LintProblem[] {
  const problems: LintProblem[] = [];
  if (!/^\s*<!doctype\s+html\s*>/i.test(html)) {
    problems.push({ rule: 'missing_doctype', detail: 'the file does not begin with <!doctype html>; without it the browser renders in quirks mode and the box model changes' });
  }
  if (!/<meta\b[^>]*\bcharset\s*=\s*["']?\s*utf-8/i.test(html)) {
    problems.push({ rule: 'missing_charset', detail: 'no <meta charset="utf-8"> is present in <head>; Vietnamese diacritics then depend on whatever the serving layer happens to send' });
  }
  if (opts.viewport) {
    const tag = /<meta\b[^>]*name\s*=\s*["']?viewport["']?[^>]*>/i.exec(html);
    if (!tag || !/content\s*=\s*["'][^"']*width\s*=\s*device-width/i.test(tag[0])) {
      problems.push({ rule: 'missing_viewport_meta', detail: 'no <meta name="viewport" content="width=device-width, initial-scale=1"> is present; without it a phone lays the page out at ~980px and scales the result down' });
    }
  }
  return problems;
}

/** Every `@page { … }` body, brace-matched rather than stopped at the first `}` (a nested at-rule
 *  would otherwise truncate it). Shared in spirit with `render_deck.js`'s `parsePageBox`: the lint
 *  pass and the measurement pass must never disagree about what `@page` says. */
export function pageRuleBodies(html: string): string[] {
  const bodies: string[] = [];
  const startRe = /@page\b[^{]*\{/gi;
  let match: RegExpExecArray | null;
  // eslint-disable-next-line no-cond-assign
  while ((match = startRe.exec(html))) {
    let depth = 1;
    let i = match.index + match[0].length;
    const start = i;
    while (i < html.length && depth > 0) {
      if (html[i] === '{') depth += 1;
      else if (html[i] === '}') depth -= 1;
      i += 1;
    }
    bodies.push(html.slice(start, depth === 0 ? i - 1 : i));
    startRe.lastIndex = i;
  }
  return bodies;
}

/** `@page` with an explicit `size`. Hard: `render_deck.js` passes `preferCSSPageSize`, so without
 *  this Puppeteer falls back to Letter portrait and prints a 16:9 deck onto the wrong aspect ratio. */
function lintPageRule(html: string): LintProblem[] {
  const bodies = pageRuleBodies(html);
  if (bodies.length === 0) return [{ rule: 'deck_page_rule', detail: 'no @page rule was found; without one the deck prints as Letter portrait instead of 16:9' }];
  if (!bodies.some((body) => /\bsize\s*:/i.test(body))) return [{ rule: 'deck_page_rule', detail: 'no @page rule declares a `size`; without one the deck prints as Letter portrait instead of 16:9' }];
  return [];
}

/**
 * The minimal hook the measurement pass depends on to run at all. `render_deck.js` iterates
 * `document.querySelectorAll('[data-slide]')`; zero matches reads as "measured clean" rather than
 * "did not measure", silently disabling the overflow/clip checks. Render-capability, not taste —
 * stays HARD even though slide count/order below is only a warning.
 */
function lintDeckStructure(html: string): LintProblem[] {
  if (parseSlides(html).length === 0) {
    return [{ rule: 'missing_structure', detail: 'no <section data-slide="…"> element was found; the layout measurement pass cannot run without at least one' }];
  }
  return [];
}

/** Slide count/order is editorial, not render-capability — a 6- or 9-slide deck prints and
 *  measures exactly as well as an 8-slide one — so this is advisory only. */
function lintDeckSlideCount(html: string): LintProblem[] {
  const slides = parseSlides(html);
  if (slides.length === 0) return [];
  const numbers = slides.map((slide) => Number(slide.hook));
  const expected = Array.from({ length: DECK_SLIDE_COUNT }, (_, i) => i + 1);
  const wellFormed = numbers.length === DECK_SLIDE_COUNT && numbers.every((n, i) => n === expected[i]);
  if (wellFormed) return [];
  return [{ rule: 'warn_deck_slide_count', detail: `expected 8 slides carrying data-slide="1".."8" once each in document order; found ${slides.length} hooked section(s)` }];
}

export function lintDeckForm(html: string): LintProblem[] {
  return [...lintDeckStructure(html), ...lintDocumentShell(html, { viewport: false }), ...lintPageRule(html), ...lintDeckSlideCount(html)];
}

export function lintLandingForm(html: string): LintProblem[] {
  return lintDocumentShell(html, { viewport: true });
}

/**
 * Rule ids that FORCE A REWRITE rather than deleting the artifact. Exported so a test can assert
 * both `SKILL.md` files document every one — code and prose drifting apart recreates the exact
 * defect the skill rewrite existed to remove.
 *
 * `overflow` / `clipped` / `page_overflow` / `measurement_timeout` stay HARD and deliberately out
 * of `TERMINAL_RULES`: persistent overflow forces a rewrite and, on the final attempt, ships
 * with a warning rather than deleting a teacher's only artifact.
 */
export const HARD_FORM_RULES: readonly string[] = [
  'missing_structure', 'missing_doctype', 'missing_charset', 'missing_viewport_meta', 'deck_page_rule',
  'overflow', 'clipped', 'page_overflow', 'measurement_timeout',
];

/** Rules that may terminally reject an artifact. Everything else degrades to a warning on the
 *  final attempt and ships. Principle: a teacher always has something to show; never something
 *  unsafe. */
export const TERMINAL_RULES: readonly string[] = [
  'no_external_url', 'no_import', 'no_data_uri',
  'no_embedded_document', 'no_srcdoc',
  // Not a content rule, but terminal for the same reason: an attempt that wrote nothing produced no
  // artifact to ship with a warning.
  'missing_output',
];

/** True when every problem in the list is one the terminal fallback may downgrade. */
export function isFormOnly(problems: LintProblem[]): boolean {
  return problems.length > 0 && problems.every((problem) => !TERMINAL_RULES.includes(problem.rule));
}

/** Rewrites the survivors of a final attempt as warnings, so `partitionProblems` lets them pass
 *  while the caller still records and surfaces every one of them. */
export function downgradeToWarnings(problems: LintProblem[]): LintProblem[] {
  return problems.map((problem) => (problem.rule.startsWith('warn_') ? problem : { rule: `warn_${problem.rule}`, detail: problem.detail }));
}
