import { describe, expect, it } from 'vitest';
import { chunkMarkdownForKnowledge } from './markdown-chunker';

describe('chunkMarkdownForKnowledge', () => {
  it('honors chunking limits for oversized single-line content', () => {
    const markdown = `# Big\n\n${Array.from({ length: 600 }, (_, i) => `word${i}`).join(' ')}`;
    const chunks = chunkMarkdownForKnowledge(markdown, { maxTokens: 120, overlapTokens: 0 });

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => Number(chunk.metadata.estimated_tokens) <= 120)).toBe(true);
  });

  it('can omit the first heading when it is only the document title', () => {
    const chunks = chunkMarkdownForKnowledge('# Title\n\nBody', { includeDocumentTitle: false });

    expect(chunks).toHaveLength(1);
    expect(chunks[0].content_text).toBe('Body');
    expect(chunks[0].heading_path).toBeNull();
  });

  it('serializes GFM tables while rebuilding knowledge chunks', () => {
    const chunks = chunkMarkdownForKnowledge(
      ['# Data', '', '| Name | Value |', '| --- | --- |', '| alpha | 1 |'].join('\n'),
      { minTokens: 1 }
    );

    expect(chunks).toHaveLength(1);
    expect(chunks[0].content_text).toContain('| Name  | Value |');
    expect(chunks[0].content_text).toContain('| alpha | 1     |');
  });
});
