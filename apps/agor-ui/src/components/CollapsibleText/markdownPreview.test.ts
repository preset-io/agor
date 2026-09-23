import { describe, expect, it } from 'vitest';
import { getMarkdownPreview, isLongMarkdown } from './markdownPreview';

describe('bounded Markdown source previews', () => {
  it('uses a character or source-line threshold, whichever is reached first', () => {
    for (const text of ['x'.repeat(1200), Array(15).fill('x').join('\n')]) {
      expect(isLongMarkdown(text)).toBe(false);
      expect(getMarkdownPreview(text)).toBe(text);
    }
    expect(isLongMarkdown('x'.repeat(1201))).toBe(true);
    expect(isLongMarkdown(Array(16).fill('x').join('\n'))).toBe(true);
  });

  it.each([
    ['newline preferred over earlier whitespace', ' '.repeat(1) + 'x'.repeat(49) + '\n', 650],
    ['newline at lookahead limit', 'x'.repeat(100) + '\n', 700],
    ['whitespace fallback', 'x'.repeat(30) + ' ' + 'x'.repeat(100), 630],
    ['newline beyond the bounded window', 'x'.repeat(101) + '\n', 600],
    ['no boundaries', 'x'.repeat(300), 600],
  ])('%s', (_name, suffix, length) => {
    const text = 'a'.repeat(600) + suffix + 'z'.repeat(2000);
    const preview = getMarkdownPreview(text);
    expect(preview).toBe(text.slice(0, length));
    expect(preview.length).toBeLessThanOrEqual(700);
  });

  it('caps tall short-line content at ten source lines', () => {
    const lines = Array.from({ length: 50 }, (_, i) => `Word${i}  `);
    const text = lines.join('\n');
    expect(text.length).toBeLessThan(1200);
    expect(isLongMarkdown(text)).toBe(true);
    expect(getMarkdownPreview(text)).toBe(lines.slice(0, 10).join('\n').trimEnd());
    const mixed = Array(9).fill('short').join('\n') + '\n' + 'x'.repeat(2000);
    expect(getMarkdownPreview(mixed).length).toBeLessThanOrEqual(700);
    expect(getMarkdownPreview(mixed).split('\n')).toHaveLength(10);
  });

  it('never extends to a distant closing code fence or splits a surrogate pair', () => {
    const code = '```text\n' + 'x'.repeat(5000) + '\n```';
    expect(getMarkdownPreview(code)).toHaveLength(600);
    const emoji = 'x'.repeat(599) + '😀' + 'y'.repeat(2000);
    expect(getMarkdownPreview(emoji)).toBe('x'.repeat(599));
  });
});
