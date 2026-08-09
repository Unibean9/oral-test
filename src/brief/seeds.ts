/**
 * Font allowlists for sell-side artifacts (landing page, deck).
 *
 * System faces with confirmed full Vietnamese diacritic coverage — Constantia/Corbel render
 * Vietnamese correctly and look intentional, which is why no webfont embedding is planned, and
 * why nothing outside these lists is permitted: no external font can load through either the
 * deck renderer's request interception or the CSP the HTML is served under.
 *
 * Art direction is not selected here: the model chooses and declares its own design direction
 * per generation (see `runtimes/.claude/skills/frontend-design/SKILL.md`'s "Design Thinking"
 * section).
 */

export const ALLOWED_DISPLAY_FONTS: readonly string[] = [
  'Constantia', 'Cambria', 'Palatino Linotype', 'Sitka Heading', 'Georgia',
  'Times New Roman', 'Iowan Old Style', 'Charter', 'Optima', 'Baskerville',
];
export const ALLOWED_BODY_FONTS: readonly string[] = [
  'Corbel', 'Candara', 'Segoe UI', 'Tahoma', 'Verdana', 'Calibri', 'Avenir Next', 'Helvetica Neue',
];

/**
 * Families permitted AFTER the first one in a `font-family` stack.
 *
 * ONE HOME, deliberately. The landing page is served to the reader's own device, so a bare
 * `Constantia, serif` degrades to the browser's default serif on Android — route prompts and
 * `formLint.ts` restate/check per-role stacks rather than "one generic fallback".
 *
 * Local family names and CSS generic keywords only. A URL here would be loaded by the reader's
 * browser and `lintNoExternalRefs` would reject the file that carried it.
 */
export const ALLOWED_FONT_FALLBACKS: readonly string[] = [
  'Georgia', 'Times New Roman', 'Segoe UI', 'Roboto', 'Helvetica', 'Arial',
  'serif', 'sans-serif', 'monospace', 'system-ui', 'ui-serif', 'ui-sans-serif',
];
