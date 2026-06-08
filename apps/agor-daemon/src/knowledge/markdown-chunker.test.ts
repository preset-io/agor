import { describe, expect, it } from 'vitest';
import { chunkMarkdownForKnowledge, normalizeKnowledgeChunkForHash } from './markdown-chunker';

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

  it('keeps unchanged section hashes stable when another section is edited', () => {
    const base = [
      '# Handbook',
      '',
      'Intro paragraph for the handbook.',
      '',
      '## Install',
      '',
      'Install step one. Install step two. Install step three.',
      '',
      '## Configure',
      '',
      'Configure alpha. Configure beta. Configure gamma.',
      '',
      '## Operate',
      '',
      'Operate safely. Watch dashboards. Roll back when needed.',
      '',
      '## Troubleshoot',
      '',
      'Check logs. Restart workers. Escalate with context.',
    ].join('\n');
    const edited = base.replace(
      'Configure alpha. Configure beta. Configure gamma.',
      'Configure alpha. Configure beta changed. Configure gamma.'
    );

    const byHeading = (markdown: string) =>
      new Map(
        chunkMarkdownForKnowledge(markdown, { minTokens: 1 }).map((chunk) => [
          chunk.heading_path,
          chunk.content_md5,
        ])
      );

    const before = byHeading(base);
    const after = byHeading(edited);

    expect(after.get('Handbook > Install')).toBe(before.get('Handbook > Install'));
    expect(after.get('Handbook > Operate')).toBe(before.get('Handbook > Operate'));
    expect(after.get('Handbook > Troubleshoot')).toBe(before.get('Handbook > Troubleshoot'));
    expect(after.get('Handbook > Configure')).not.toBe(before.get('Handbook > Configure'));
  });

  it('does not change chunk hashes for trailing-space-only edits', () => {
    const clean = ['# Page', '', '## Stable', '', 'Line one', '', 'Line two'].join('\n');
    const trailingSpaces = ['# Page', '', '## Stable', '', 'Line one   ', '', 'Line two\t'].join(
      '\n'
    );

    const cleanChunk = chunkMarkdownForKnowledge(clean, { minTokens: 1 }).find(
      (chunk) => chunk.heading_path === 'Page > Stable'
    );
    const spaceChunk = chunkMarkdownForKnowledge(trailingSpaces, { minTokens: 1 }).find(
      (chunk) => chunk.heading_path === 'Page > Stable'
    );

    expect(spaceChunk?.content_md5).toBe(cleanChunk?.content_md5);
  });

  it('keeps hashes stable for excessive blank lines outside fenced code', () => {
    const compact = ['# Page', '', '## Stable', '', 'Line one', '', 'Line two'].join('\n');
    const spaced = ['# Page', '', '## Stable', '', 'Line one', '', '', '', 'Line two'].join('\n');

    const compactChunk = chunkMarkdownForKnowledge(compact, { minTokens: 1 }).find(
      (chunk) => chunk.heading_path === 'Page > Stable'
    );
    const spacedChunk = chunkMarkdownForKnowledge(spaced, { minTokens: 1 }).find(
      (chunk) => chunk.heading_path === 'Page > Stable'
    );

    expect(spacedChunk?.content_md5).toBe(compactChunk?.content_md5);
  });

  it('does not collapse blank lines inside fenced code for hashing', () => {
    const oneBlank = [
      '# Page',
      '',
      '## Code',
      '',
      '```js',
      'const x = 1;',
      '',
      'const y = 2;',
      '```',
    ].join('\n');
    const manyBlanks = [
      '# Page',
      '',
      '## Code',
      '',
      '```js',
      'const x = 1;',
      '',
      '',
      '',
      'const y = 2;',
      '```',
    ].join('\n');

    const oneBlankChunk = chunkMarkdownForKnowledge(oneBlank, { minTokens: 1 }).find(
      (chunk) => chunk.heading_path === 'Page > Code'
    );
    const manyBlanksChunk = chunkMarkdownForKnowledge(manyBlanks, { minTokens: 1 }).find(
      (chunk) => chunk.heading_path === 'Page > Code'
    );

    expect(manyBlanksChunk?.content_md5).not.toBe(oneBlankChunk?.content_md5);
  });

  it('preserves trailing whitespace inside fenced code for direct hash normalization', () => {
    expect(normalizeKnowledgeChunkForHash('```\nvalue\n```')).not.toBe(
      normalizeKnowledgeChunkForHash('```\nvalue  \n```')
    );
  });
});
