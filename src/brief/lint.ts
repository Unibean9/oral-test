/**
 * Deterministic SECURITY checks on what the design skills emitted.
 *
 * `<script>` is permitted (CSP's `sandbox allow-scripts` is the runtime control, not this lint) —
 * what remains here is everything that reaches outside the file: external URLs, `@import`,
 * embedded documents, `srcdoc`, non-image `data:` URIs. Nothing about content truthfulness, taste,
 * or scripting itself is checked here or anywhere else in this pipeline.
 *
 * Deliberately free of Fastify imports so it is unit-testable in isolation.
 */

export interface LintProblem {
  rule: string;
  detail: string;
}

/**
 * Strips everything that is not reader-visible text: `<style>` and `<script>` bodies, HTML
 * comments, then all remaining tags. Exported and tested separately because stripping `<style>`
 * is what keeps a downstream text-based check from reading CSS as prose.
 */
export function extractTextContent(html: string): string {
  return html
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/\s+/g, ' ')
    .trim();
}

// `srcdoc`, `formaction`, `xlink:href` and `action` join the classic four because each is a
// navigation or fetch target in its own right; leaving them out let a URL reach the network through
// an attribute nothing was watching.
const EXTERNAL_URL_RE = /(?:src|href|content|data|poster|srcdoc|formaction|xlink:href|action)\s*=\s*["']?\s*(?:https?:)?\/\//gi;
const CSS_URL_RE = /url\s*\(\s*["']?\s*(?:https?:)?\/\//gi;
const IMPORT_RE = /@import\b/gi;
const DATA_URI_RE = /(?:(?:src|href|content|poster|srcdoc|formaction|xlink:href|action)\s*=\s*|url\s*\(\s*)["']?\s*data:/gi;
/**
 * Document-embedding elements. NOT a style rule — a blocking precondition of measuring the landing
 * page in a browser, which loads from `file://` with NO CSP. `data:text/html;base64,…` in an
 * `<iframe>` is a *document* scheme Chromium executes, and `SCRIPT_RE` cannot see through base64.
 */
const EMBEDDED_DOCUMENT_RE = /<(?:iframe|object|embed|frame)\b/gi;
const SRCDOC_RE = /[\s"']srcdoc\s*=/gi;
/** `data:` restricted to images, applied where `allowDataUris` is true. */
const NON_IMAGE_DATA_URI_RE = /data:(?!image\/)/gi;

/**
 * Rejects any route out of the file. The `content-security-policy: sandbox` header the GET routes
 * send carries no `default-src`, so it does not block outbound requests — this function is what
 * does, and it is the only lint left in this pipeline that may terminally reject an artifact.
 *
 * `allowDataUris` is false for the deck: `data:` is untested through the PDF renderer's request
 * interception. The landing page never passes through that renderer.
 */
export function lintNoExternalRefs(html: string, opts: { allowDataUris: boolean }): LintProblem[] {
  const problems: LintProblem[] = [];
  const scan = (pattern: RegExp, rule: string, describe: (match: RegExpMatchArray) => string) => {
    for (const match of html.matchAll(pattern)) {
      problems.push({ rule, detail: describe(match) });
      break; // one report per rule is enough to make a retry prompt actionable
    }
  };
  // Neither the matched URL text nor the attribute name is reported verbatim: these details are
  // concatenated into the retry prompt without wrapUntrusted(), and "never matched text" is this
  // module's own contract.
  scan(EXTERNAL_URL_RE, 'no_external_url', () => 'an attribute references an external http(s) URL; every reference must stay inside the file');
  scan(CSS_URL_RE, 'no_external_url', () => 'a CSS url() references an external http(s) address; all imagery must be inline SVG or a CSS gradient');
  scan(IMPORT_RE, 'no_import', () => '@import is not permitted; all CSS must be inline');
  scan(EMBEDDED_DOCUMENT_RE, 'no_embedded_document', () => '<iframe>, <object>, <embed> and <frame> are not permitted');
  scan(SRCDOC_RE, 'no_srcdoc', () => 'the srcdoc attribute is not permitted');
  if (opts.allowDataUris) scan(NON_IMAGE_DATA_URI_RE, 'no_data_uri', () => 'only data:image/... URIs are permitted; a data: document scheme is executable content');
  else scan(DATA_URI_RE, 'no_data_uri', () => 'data: URIs are not permitted in the deck');
  return problems;
}

/** Splits a lint result into the problems that must fail the request and the ones that are only
 *  worth logging. The `warn_` prefix is the contract. */
export function partitionProblems(problems: LintProblem[]): { failures: LintProblem[]; warnings: LintProblem[] } {
  return {
    failures: problems.filter((problem) => !problem.rule.startsWith('warn_')),
    warnings: problems.filter((problem) => problem.rule.startsWith('warn_')),
  };
}
