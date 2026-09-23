// Source budgets, independent of viewport width. Keep the eligibility
// threshold above the preview ceiling so expansion always reveals useful text.
const COLLAPSE_AFTER = 1200;
const COLLAPSE_AFTER_LINES = 15;
const PREVIEW_LINES = 10;
const PREVIEW_CHARS = 600;
const BOUNDARY_LOOKAHEAD = 100;

export function isLongMarkdown(markdown: string): boolean {
  return (
    markdown.length > COLLAPSE_AFTER ||
    markdown.split('\n', COLLAPSE_AFTER_LINES + 1).length > COLLAPSE_AFTER_LINES
  );
}

/** Bounded source preview; Streamdown owns incomplete Markdown repair. */
export function getMarkdownPreview(markdown: string): string {
  if (!isLongMarkdown(markdown)) return markdown;
  const nearby = markdown.slice(PREVIEW_CHARS, PREVIEW_CHARS + BOUNDARY_LOOKAHEAD + 1);
  const newline = nearby.indexOf('\n');
  const boundary = newline >= 0 ? newline : nearby.search(/\s/u);
  const characterEnd = PREVIEW_CHARS + Math.max(0, boundary);
  // Literal newlines, not estimated wrapped lines. Never extend a fence past
  // either budget; Streamdown handles the deliberately incomplete preview.
  const lineEnd = markdown.split('\n', PREVIEW_LINES).join('\n').length;
  let end = Math.min(characterEnd, lineEnd);
  // Do not leave half of an emoji/supplementary character at a hard cutoff.
  if ((markdown.codePointAt(end - 1) ?? 0) > 0xffff) end -= 1;
  return markdown.slice(0, end).trimEnd();
}
