import { describe, expect, it } from 'vitest';
import { extractLinksFromMessage } from './link';
import type { Message } from './message';

function message(content: Message['content']): Pick<Message, 'content'> {
  return { content };
}

describe('extractLinksFromMessage', () => {
  it('extracts KB refs, generic URLs, and obvious GitHub issue/PR URLs from text', () => {
    const links = extractLinksFromMessage(
      message(
        'See agor://kb/team/runbook.md and /knowledge/team/Notes plus https://example.com/a. ' +
          'GitHub: https://github.com/preset-io/agor/issues/90 and https://github.com/preset-io/agor/pull/91'
      )
    );

    expect(links).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'kb_ref', ref_uri: 'agor://kb/team/runbook.md' }),
        expect.objectContaining({ kind: 'kb_ref', ref_uri: 'agor://kb/team/Notes' }),
        expect.objectContaining({ kind: 'url', url: 'https://example.com/a' }),
        expect.objectContaining({
          kind: 'issue',
          url: 'https://github.com/preset-io/agor/issues/90',
        }),
        expect.objectContaining({ kind: 'pr', url: 'https://github.com/preset-io/agor/pull/91' }),
      ])
    );
  });

  it('only scans string content and text blocks', () => {
    const links = extractLinksFromMessage(
      message([
        { type: 'text', text: 'Visible https://example.com/visible' },
        { type: 'tool_use', input: { url: 'https://example.com/tool-json' } },
        { type: 'image', source: { url: 'https://example.com/image' } },
      ])
    );

    expect(links.map((link) => link.url)).toEqual(['https://example.com/visible']);
  });

  it('deduplicates repeated targets in one message', () => {
    const links = extractLinksFromMessage(
      message(
        'https://example.com/thing https://example.com/thing agor://kb/team/a.md agor://kb/team/a.md'
      )
    );

    expect(links).toHaveLength(2);
  });

  it('ignores non-text structured message payloads', () => {
    const links = extractLinksFromMessage(
      message({
        request_id: 'r1',
        status: 'pending',
        tool_name: 'x',
        tool_input: { url: 'https://example.com' },
      } as Message['content'])
    );

    expect(links).toEqual([]);
  });
});
