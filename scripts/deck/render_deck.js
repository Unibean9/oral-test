#!/usr/bin/env node
// deck.html -> deck.pdf renderer. Invoked by TRUSTED BACKEND CODE ONLY, never by Claude: a
// PreToolUse hook can only inspect a Bash command string, not what a spawned interpreter
// actually writes at runtime, so this render step is never delegated to Claude. Claude authors
// deck.html directly via its single Write call (hook-checkable, single path); this script only
// prints that existing file to PDF. Its output directory is HARD-CODED from a validated --room
// id, not accepted as a free-form path argument, so there is nothing for a malicious deck.html
// to redirect.

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

// scripts/deck/ -> scripts/ -> repo root, then into runtimes/. This script is server
// infrastructure, not skill documentation, so it lives outside the skill tree the model reads.
// BRAINSTORM_SYSTEM_ROOT mirrors the override in src/claude-cli/spawn.ts: the two halves must
// never disagree about where room/ lives, or a test harness redirects one and not the other.
// Both are process-environment values set by the trusted backend, never by untrusted input.
const SYSTEM_ROOT = process.env.BRAINSTORM_SYSTEM_ROOT
  ? path.resolve(process.env.BRAINSTORM_SYSTEM_ROOT)
  : path.resolve(__dirname, '..', '..', 'runtimes');
const ROOM_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--room') out.room = argv[++i];
    else if (argv[i] === '--measure') out.measure = 'deck';
    else if (argv[i] === '--measure-landing') out.measure = 'landing';
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Measurement.
//
// The gap the rest of the pipeline cannot close is not "the model cannot see" — it is that NOBODY
// MEASURES. Letting the model look at screenshots is the most expensive way to fix that; asking the
// browser that is already in the pipeline for numbers is the cheapest, and it is deterministic.
//
// Two things about this page are worth stating plainly, because both are load-bearing:
//
//  1. `page.pdf()` renders in PRINT media, and this script never emulates screen. A deck
//     deliberately has two layouts — `@media print` with `break-after: page` for the archive, and
//     scroll-snap for the screen. Measuring the screen layout would measure the one that is NOT
//     archived, so deck measurement emulates print.
//  2. **The measured page has NO CSP, and `<script>` is permitted content.** The sandboxed CSP
//     header exists only on the GET route; a `file://` load carries nothing, so any script the
//     artifact contains runs here with no sandbox at all. `installInterception` below is what
//     keeps that safe: every non-navigation request is aborted regardless of what the script tries
//     to reach, so a script has nowhere to send data even though nothing stops it from running.
//     `no_embedded_document` and `no_srcdoc` are the only lint rules left as a barrier, and `data:`
//     is narrowed to images below.
// ---------------------------------------------------------------------------------------------

/** Caps the JSON that crosses the pipe. A pathological file could otherwise report one record per
 *  element; the backend also caps its side, and both caps exist because an unread or unbounded pipe
 *  is what makes a child block forever. */
const MAX_RECORDS = 50;
const MEASUREMENT_SCHEMA = 1;

/**
 * Every `@page { … }` body, brace-matched rather than stopped at the first `}`.
 *
 * `[^}]*` truncates the moment a nested at-rule appears inside `@page` (`@bottom-center { … }` is
 * valid CSS there), which would make a legitimate `size` declaration invisible. Mirrors
 * `formLint.ts`'s `pageRuleBodies` — the two must never disagree about what `@page` says, or the
 * lint pass and this measurement pass judge a deck against two different page boxes.
 */
function pageRuleBodies(html) {
  const bodies = [];
  const startRe = /@page\b[^{]*\{/gi;
  let match;
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

/** The `@page` box, so the deck is measured in the frame it actually prints into. Falls back to
 *  16:9 at the size both skills specify; `deck_page_rule` is what makes the fallback rare. */
function parsePageBox(html) {
  for (const body of pageRuleBodies(html)) {
    const size = /\bsize\s*:\s*([0-9.]+)px\s+([0-9.]+)px/i.exec(body);
    if (size) return { width: Math.round(Number(size[1])), height: Math.round(Number(size[2])) };
  }
  return { width: 1600, height: 900 };
}

/**
 * Request interception, per target.
 *
 * The deck allows nothing but its own navigation, exactly as the PDF path does. The landing page
 * additionally allows `data:image/…` — and ONLY images: `data:text/html;base64,…` is a document
 * scheme Chromium executes, so allowing `data:` wholesale here would hand a generated page the one
 * script-execution surface the whole pipeline is built to deny it.
 */
function installInterception(page, fileUrlFolded, fold, allowDataImages) {
  page.on('request', (request) => {
    const url = request.url();
    if (fold(url) === fileUrlFolded) return request.continue();
    if (allowDataImages && /^data:image\//i.test(url)) return request.continue();
    return request.abort();
  });
}

/** Runs in the page. Returns overflow/clipping findings and per-slide type-size floors. */
/* c8 ignore start -- executed inside Chromium, not in the Node process under test */
function collectDeckFindings(tolerancePx) {
  const findings = [];
  // `cqh` resolves against the slide's OWN container, and `transform: scale()` to fit a stage is a
  // common idiom, so a floor converted to a flat pixel number would be wrong on both counts. Each
  // floor is computed from that slide's measured box, with the effective scale folded in.
  const effectiveScale = (element) => {
    let scale = 1;
    for (let node = element; node && node !== document.documentElement; node = node.parentElement) {
      const transform = getComputedStyle(node).transform;
      if (!transform || transform === 'none') continue;
      const match = /matrix\(([^,]+),/.exec(transform) || /matrix3d\(([^,]+),/.exec(transform);
      if (match) scale *= Math.abs(Number(match[1])) || 1;
    }
    return scale;
  };
  const hasOwnText = (element) => Array.from(element.childNodes).some((n) => n.nodeType === 3 && n.textContent.trim().length > 0);

  const slides = Array.from(document.querySelectorAll('[data-slide]'));
  slides.forEach((slide, index) => {
    const number = index + 1;
    const box = slide.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0) {
      findings.push({ slide: number, kind: 'overflow', tag: slide.tagName.toLowerCase(), sizePx: 0 });
      return;
    }
    const scale = effectiveScale(slide);
    const minText = 0.035 * box.height * scale * 0.95;
    const minHeadline = 0.10 * box.height * scale * 0.95;
    let largest = 0;

    for (const element of slide.querySelectorAll('*')) {
      const rect = element.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        const spills = rect.left < box.left - tolerancePx || rect.right > box.right + tolerancePx
          || rect.top < box.top - tolerancePx || rect.bottom > box.bottom + tolerancePx;
        if (spills && findings.length < 200) {
          findings.push({ slide: number, kind: 'overflow', tag: element.tagName.toLowerCase(), sizePx: Math.round(Math.max(rect.width, rect.height)) });
        }
      }
      const style = getComputedStyle(element);
      const clipped = (style.overflow === 'hidden' || style.overflowX === 'hidden' || style.overflowY === 'hidden')
        && (element.scrollWidth > element.clientWidth + 1 || element.scrollHeight > element.clientHeight + 1);
      if (clipped && element.innerText && element.innerText.trim() && findings.length < 200) {
        findings.push({ slide: number, kind: 'clipped', tag: element.tagName.toLowerCase(), sizePx: Math.round(element.scrollHeight - element.clientHeight) });
      }
      if (!hasOwnText(element)) continue;
      const fontSize = parseFloat(style.fontSize) * effectiveScale(element);
      if (!Number.isFinite(fontSize) || fontSize <= 0) continue;
      largest = Math.max(largest, fontSize);
      if (fontSize < minText && findings.length < 200) {
        findings.push({ slide: number, kind: 'text_too_small', tag: element.tagName.toLowerCase(), sizePx: Math.round(fontSize) });
      }
    }
    if (largest > 0 && largest < minHeadline) {
      findings.push({ slide: number, kind: 'headline_too_small', tag: 'slide', sizePx: Math.round(largest) });
    }
  });
  return { slides: slides.length, findings };
}

/** Runs in the page, at 375. Reports the SECTION INDEX, never the `data-section` value. */
function collectLandingFindings() {
  const findings = [];
  const root = document.documentElement;
  if (root.scrollWidth > root.clientWidth + 1) {
    findings.push({ section: 0, kind: 'page_overflow', tag: 'html', sizePx: Math.round(root.scrollWidth - root.clientWidth) });
  }
  const sections = Array.from(document.querySelectorAll('[data-section]'));
  const limit = root.clientWidth + 1;
  sections.forEach((section, index) => {
    for (const element of section.querySelectorAll('*')) {
      const rect = element.getBoundingClientRect();
      if (rect.width > 0 && rect.right > limit && findings.length < 200) {
        findings.push({ section: index + 1, kind: 'element_overflow', tag: element.tagName.toLowerCase(), sizePx: Math.round(rect.right - limit) });
        break;
      }
    }
  });
  return { sections: sections.length, findings };
}
/* c8 ignore stop */

async function measure(target, htmlPath) {
  const puppeteer = require('puppeteer');
  const html = fs.readFileSync(htmlPath, 'utf8');
  const browser = await puppeteer.launch();
  try {
    const page = await browser.newPage();
    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
    const fileUrl = pathToFileURL(htmlPath).href;
    const fold = (s) => (process.platform === 'win32' ? s.toLowerCase() : s);
    await page.setRequestInterception(true);
    installInterception(page, fold(fileUrl), fold, target === 'landing');

    let result;
    if (target === 'deck') {
      const box = parsePageBox(html);
      await page.setViewport({ width: box.width, height: box.height, deviceScaleFactor: 1 });
      // PRINT, not screen — see the header note. Set before navigation so it applies to first paint.
      await page.emulateMediaType('print');
      await page.goto(fileUrl, { waitUntil: 'networkidle2' });
      result = await page.evaluate(collectDeckFindings, 2);
      result.box = box;
    } else {
      // `isMobile` is what makes this measurement able to SEE the defect it exists to catch. Without
      // it Chromium sets the CSS layout viewport to 375 directly, so a page carrying no
      // `<meta name="viewport">` measures identically to one that does — the overflow check reports
      // clean while a real phone lays the page out at ~980px and scales the result down. With it,
      // the measurement finally reflects the device the skill names as its primary reader.
      await page.setViewport({ width: 375, height: 812, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
      await page.goto(fileUrl, { waitUntil: 'networkidle2' });
      result = await page.evaluate(collectLandingFindings);
      result.box = { width: 375, height: 812 };
    }

    const truncated = result.findings.length > MAX_RECORDS;
    // Truncation is REPORTED, never silent: a capped list that looked complete would read as
    // "measured clean" for every finding past the cap.
    return { schema: MEASUREMENT_SCHEMA, target, ...result, findings: result.findings.slice(0, MAX_RECORDS), truncated };
  } finally {
    await browser.close();
  }
}

async function renderPdf(htmlPath, outPath) {
  const puppeteer = require('puppeteer');
  // Chromium sandbox stays ENABLED — no --no-sandbox launch arg. Run the BE
  // process itself as a non-root/non-admin OS user in deployment, per the plan's guidance.
  const browser = await puppeteer.launch();
  try {
    const page = await browser.newPage();
    // Deterministic guard against the blank-print failure mode: a scroll-linked reveal
    // (animation-timeline: view()) whose fill leaves elements at opacity 0 never advances during
    // a print, so the page prints blank while looking perfect when scrolled by hand. Both design
    // skills are required to carry a prefers-reduced-motion escape hatch; forcing the media
    // feature here means the guarantee does not depend on the model having obeyed. Set before
    // goto so it applies to first paint.
    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
    // deck.html is Claude-authored content derived from untrusted-influenced input, and the
    // skill's own contract forbids it making any external request — so the only request this
    // render step should ever see is its own top-level navigation to htmlPath. Exact match only,
    // no directory-prefix allowance: a sub-resource request (image, iframe, favicon probe) is
    // exactly the kind of thing the skill promises never to emit, so there is nothing legitimate
    // for a broader allowlist to cover, and a prefix match invites both a case-variant sibling
    // (".../ARTIFACTS/...") and a percent-encoded traversal the WHATWG URL parser won't collapse.
    await page.setRequestInterception(true);
    const fileUrl = pathToFileURL(htmlPath).href;
    // On Windows, Chromium normalises a file:// URL's drive letter to uppercase while Node's
    // pathToFileURL emits it lowercase, so an exact-case compare here would reject the renderer's
    // own navigation request. Fold only where the filesystem is itself case-insensitive (mirrors
    // src/artifacts/paths.ts's `canonical`), so a POSIX deployment keeps exact-case matching.
    const fold = (s) => (process.platform === 'win32' ? s.toLowerCase() : s);
    const fileUrlFolded = fold(fileUrl);
    page.on('request', (request) => {
      if (fold(request.url()) === fileUrlFolded) {
        request.continue();
      } else {
        request.abort();
      }
    });
    await page.goto(fileUrl, { waitUntil: 'networkidle2' });
    // preferCSSPageSize lets the deck's own `@page` rule (SKILL.md requires one) control page
    // size/orientation — Puppeteer otherwise silently defaults to Letter portrait regardless of
    // what @media print declares, which would print a 16:9 deck onto the wrong aspect ratio.
    // Written to a temp file and renamed, because the backend SIGTERMs this process on its render
    // deadline and Chromium may already have flushed part of the PDF. Writing straight to outPath
    // left a TRUNCATED deck.pdf that exists — and every route checks existence only, so it was
    // served as a finished deck. The temp file stays in the same directory: os.tmpdir() may be a
    // different volume, where rename degrades to a copy and loses atomicity, and it would also put
    // the file outside the room boundary. Derived from outPath, never from an argument.
    const tmpPath = `${outPath}.tmp-${process.pid}`;
    try {
      await page.pdf({ path: tmpPath, printBackground: true, preferCSSPageSize: true });
      fs.renameSync(tmpPath, outPath);
    } catch (err) {
      try { fs.rmSync(tmpPath, { force: true }); } catch { /* best effort */ }
      throw err;
    }
  } finally {
    await browser.close();
  }
}

async function main() {
  const { room, measure: target } = parseArgs(process.argv.slice(2));
  if (!room || !ROOM_ID_RE.test(room)) {
    throw new Error(`invalid or missing --room (expected a UUID), got: ${room}`);
  }

  // Every path is derived from the validated --room id, exactly as the render path is. There is no
  // free-form path argument for a malicious artifact to redirect.
  const artifactsDir = path.join(SYSTEM_ROOT, 'room', room, 'artifacts');
  const name = target === 'landing' ? 'landing-page.html' : 'deck.html';
  const htmlPath = path.join(artifactsDir, name);
  if (!fs.existsSync(htmlPath)) {
    throw new Error(`${name} not found at ${htmlPath} — run the design skill first`);
  }

  if (target) {
    // Exactly one JSON object, on the last line, so the backend's reader can find it past any
    // banner Chromium or Node happens to emit.
    process.stdout.write(`${JSON.stringify(await measure(target, htmlPath))}\n`);
    return;
  }
  await renderPdf(htmlPath, path.join(artifactsDir, 'deck.pdf'));
}

// Guarded so the test suite can require this file to unit-test its exports without running the
// CLI. The backend spawns it as `node render_deck.js ...`, which makes it the main module, so
// production behaviour is unchanged.
if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`render_deck.js failed: ${err.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { parseArgs, renderPdf, measure, parsePageBox, MAX_RECORDS, MEASUREMENT_SCHEMA };
