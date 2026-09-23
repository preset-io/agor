// Source-character budgets, independent of viewport width. Keep the eligibility
// threshold above the preview ceiling so expansion always reveals useful text.
const COLLAPSE_AFTER = 2000;
const PREVIEW_CHARS = 1200;
const BOUNDARY_LOOKAHEAD = 200;

export function isLongMarkdown(markdown: string): boolean {
  return markdown.length > COLLAPSE_AFTER;
}

/** Bounded source preview; Streamdown owns incomplete Markdown repair. */
export function getMarkdownPreview(markdown: string): string {
  if (!isLongMarkdown(markdown)) return markdown;
  const nearby = markdown.slice(PREVIEW_CHARS, PREVIEW_CHARS + BOUNDARY_LOOKAHEAD + 1);
  const newline = nearby.indexOf('\n');
  const boundary = newline >= 0 ? newline : nearby.search(/\s/u);
  let end = PREVIEW_CHARS + Math.max(0, boundary);
  // Do not leave half of an emoji/supplementary character at a hard cutoff.
  if ((markdown.codePointAt(end - 1) ?? 0) > 0xffff) end -= 1;
  return markdown.slice(0, end).trimEnd();
}
