/**
 * Strips markdown-style formatting before text reaches the TTS engine, so a stray "**", "##",
 * "// " or similar is never read aloud literally instead of being treated as formatting. Applied
 * only to the text handed to TTS; any on-screen rendering of the same text is left untouched.
 */
export function stripMarkdownForSpeech(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ') // fenced code blocks
    .replace(/`([^`]+)`/g, '$1') // inline code
    .replace(/^\s{0,3}#{1,6}\s+/gm, '') // headers
    .replace(/^\s{0,3}>\s?/gm, '') // blockquote markers
    .replace(/^\s*[-*+]\s+/gm, '') // bullet list markers
    .replace(/^\s*\d+[.)]\s+/gm, '') // numbered list markers
    .replace(/\*\*([^*]+)\*\*/g, '$1') // bold
    .replace(/__([^_]+)__/g, '$1') // bold (underscore)
    .replace(/\*([^*]+)\*/g, '$1') // italic
    .replace(/\/\/+/g, ' ') // "//" comment-style markers
    .replace(/[*_~#]/g, '') // any leftover stray markdown characters
    .replace(/\s+/g, ' ')
    .trim();
}
