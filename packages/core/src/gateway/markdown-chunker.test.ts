import { describe, expect, it } from 'vitest';
import { chunkMarkdown, codePointLength, utf16Length } from './markdown-chunker';

describe('chunkMarkdown', () => {
  it('measures UTF-16 units when asked, so astral text uses two units each', () => {
    const text = '😀'.repeat(100);
    const chunks = chunkMarkdown(text, { limit: 64, measure: utf16Length });
    expect(chunks.every((chunk) => chunk.length <= 64)).toBe(true);
    expect(chunks.join('')).toBe(text);
    expect(chunkMarkdown(text, { limit: 64, measure: codePointLength })).toHaveLength(2);
  });

  it('closes and reopens a fence within a UTF-16 budget', () => {
    const text = `\`\`\`ts\n${'x'.repeat(200)}\n\`\`\``;
    const chunks = chunkMarkdown(text, { limit: 64, measure: utf16Length });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 64)).toBe(true);
    expect(chunks.slice(1).every((chunk) => chunk.startsWith('```ts\n'))).toBe(true);
    expect(chunks.slice(0, -1).every((chunk) => chunk.endsWith('\n```'))).toBe(true);
  });

  it('labels limit errors with the provider', () => {
    expect(() => chunkMarkdown('text', { limit: 8, label: 'Teams' })).toThrow(
      'Teams chunk limit is too small'
    );
  });
});
