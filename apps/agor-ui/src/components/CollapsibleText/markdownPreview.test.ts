import { describe, expect, it } from 'vitest';
import { getMarkdownPreview, isLongMarkdown } from './markdownPreview';

describe('bounded Markdown source previews', () => {
  it('uses a strict 2000-character threshold, not source or visual lines', () => {
    for (const text of ['x'.repeat(2000), 'x\n'.repeat(1000)]) {
      expect(isLongMarkdown(text)).toBe(false);
      expect(getMarkdownPreview(text)).toBe(text);
    }
    expect(isLongMarkdown('x'.repeat(2001))).toBe(true);
  });

  it.each([
    ['newline preferred over earlier whitespace', ' '.repeat(1) + 'x'.repeat(99) + '\n', 1300],
    ['newline at lookahead limit', 'x'.repeat(200) + '\n', 1400],
    ['whitespace fallback', 'x'.repeat(30) + ' ' + 'x'.repeat(200), 1230],
    ['newline beyond the bounded window', 'x'.repeat(201) + '\n', 1200],
    ['no boundaries', 'x'.repeat(300), 1200],
  ])('%s', (_name, suffix, length) => {
    const text = 'a'.repeat(1200) + suffix + 'z'.repeat(2000);
    const preview = getMarkdownPreview(text);
    expect(preview).toBe(text.slice(0, length));
    expect(preview.length).toBeLessThanOrEqual(1400);
  });

  it('never extends to a distant closing code fence or splits a surrogate pair', () => {
    const code = '```text\n' + 'x'.repeat(5000) + '\n```';
    expect(getMarkdownPreview(code)).toHaveLength(1200);
    const emoji = 'x'.repeat(1199) + '😀' + 'y'.repeat(2000);
    expect(getMarkdownPreview(emoji)).toBe('x'.repeat(1199));
  });
});
