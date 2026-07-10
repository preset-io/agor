import { describe, expect, it } from 'vitest';
import {
  countLinkTargets,
  extractLinksFromMessage,
  getLinkTargetCompatibilityError,
  getLinkTargetField,
  isInternalLinkData,
  LINK_KIND_TARGET_FIELD,
  LINK_SOURCE_TARGET_FIELDS,
  normalizeLinkTargetKey,
} from './link';
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

describe('link target semantics', () => {
  it('defines target fields for every link kind and source', () => {
    expect(LINK_KIND_TARGET_FIELD).toMatchObject({
      issue: 'url',
      pr: 'url',
      url: 'url',
      kb_ref: 'ref_uri',
      internal: 'ref_uri',
      image: 'file_path',
      document: 'file_path',
    });
    expect(LINK_SOURCE_TARGET_FIELDS).toMatchObject({
      upload: ['file_path'],
      parsed: ['url', 'ref_uri'],
      manual: ['url', 'ref_uri', 'file_path'],
    });
  });

  it('resolves the populated target field', () => {
    expect(getLinkTargetField({ url: 'https://example.com' })).toBe('url');
    expect(getLinkTargetField({ ref_uri: 'agor://kb/team/runbook.md' })).toBe('ref_uri');
    expect(getLinkTargetField({ file_path: '/uploads/image.png' })).toBe('file_path');
    expect(getLinkTargetField({})).toBeNull();
    expect(countLinkTargets({ url: 'https://example.com', ref_uri: 'agor://kb/team/a.md' })).toBe(
      2
    );
  });

  it('recognizes internal link payloads without classifying public or metadata-only payloads', () => {
    expect(isInternalLinkData({ kind: 'internal' })).toBe(true);
    expect(isInternalLinkData({ target_object_type: 'session' })).toBe(true);
    expect(isInternalLinkData({ target_object_id: '01933e4a-7b89-7c35-a8f3-9d2e1c4b5a6f' })).toBe(
      true
    );
    expect(isInternalLinkData({ target_object_type: null, target_object_id: null })).toBe(false);
    expect(isInternalLinkData({ kind: 'url', url: 'https://example.com' })).toBe(false);
    expect(isInternalLinkData({ kind: 'kb_ref', ref_uri: 'agor://kb/team/runbook.md' })).toBe(
      false
    );
    expect(isInternalLinkData({ title: 'Updated title' })).toBe(false);
  });

  it('normalizes the populated target key', () => {
    expect(normalizeLinkTargetKey({ url: 'https://EXAMPLE.com/a#section' })).toBe(
      'url:https://example.com/a'
    );
    expect(normalizeLinkTargetKey({ ref_uri: ' AGOR://KB/Team/Runbook.md ' })).toBe(
      'ref:agor://kb/team/runbook.md'
    );
    expect(normalizeLinkTargetKey({ file_path: ' /uploads/image.png ' })).toBe(
      'file:/uploads/image.png'
    );
    expect(
      normalizeLinkTargetKey({
        ref_uri: 'agor://session/01933e4a-7b89-7c35-a8f3-9d2e1c4b5a6f',
        target_object_type: 'session',
        target_object_id: '01933e4a-7b89-7c35-a8f3-9d2e1c4b5a6f',
      })
    ).toBe('object:session:01933e4a-7b89-7c35-a8f3-9d2e1c4b5a6f');
    expect(normalizeLinkTargetKey({})).toBeNull();
  });

  it('describes incompatible kind/source/target combinations', () => {
    expect(
      getLinkTargetCompatibilityError({
        kind: 'image',
        source: 'manual',
        url: 'https://example.com/image.png',
      })
    ).toBe('Link kind image requires target file_path');
    expect(
      getLinkTargetCompatibilityError({
        kind: 'image',
        source: 'parsed',
        file_path: '/uploads/image.png',
      })
    ).toBe('Link source parsed cannot use target file_path');
    expect(
      getLinkTargetCompatibilityError({
        kind: 'kb_ref',
        source: 'parsed',
        ref_uri: 'agor://kb/team/runbook.md',
      })
    ).toBeNull();
    expect(
      getLinkTargetCompatibilityError({
        kind: 'kb_ref',
        source: 'manual',
        ref_uri: 'agor://session/01933e4a-7b89-7c35-a8f3-9d2e1c4b5a6f',
      })
    ).toBe('Knowledge links require an agor://kb/ ref_uri');
    expect(
      getLinkTargetCompatibilityError({
        kind: 'internal',
        source: 'manual',
        ref_uri: 'agor://session/01933e4a-7b89-7c35-a8f3-9d2e1c4b5a6f',
        target_object_type: 'session',
        target_object_id: '01933e4a-7b89-7c35-a8f3-9d2e1c4b5a6f',
      })
    ).toBeNull();
    expect(
      getLinkTargetCompatibilityError({
        kind: 'internal',
        source: 'manual',
        ref_uri: 'agor://session/01933e4a-7b89-7c35-a8f3-9d2e1c4b5a6f',
      })
    ).toBe('Internal links require target_object_type and target_object_id');
  });
});
