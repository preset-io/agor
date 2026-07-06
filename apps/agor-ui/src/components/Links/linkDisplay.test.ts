import type { Branch, Link } from '@agor-live/client';
import { normalizeRefTargetKey, normalizeUrlTargetKey } from '@agor-live/client';
import { describe, expect, it } from 'vitest';
import {
  buildLinkDisplayItems,
  getCompactLinkDisplayName,
  getLinkDisplayCategory,
  getLinkDisplayGlyphLabel,
  getLinkDisplayPillLabel,
  getLinkDisplaySecondaryLabel,
  type LinkDisplayItem,
  linkToDisplayItem,
  routeForKnowledgeRefUri,
  sortLinkDisplayItems,
  targetForLinkDisplay,
} from './linkDisplay';

const now = '2026-07-01T00:00:00.000Z';

function makeLink(patch: Partial<Link> & Pick<Link, 'link_id' | 'kind' | 'source'>): Link {
  return {
    link_id: patch.link_id,
    branch_id: null,
    session_id: 'session-1' as Link['session_id'],
    source_message_id: null,
    kind: patch.kind,
    source: patch.source,
    url: null,
    ref_uri: null,
    file_path: null,
    target_key: patch.url
      ? normalizeUrlTargetKey(patch.url)
      : patch.ref_uri
        ? normalizeRefTargetKey(patch.ref_uri)
        : patch.file_path
          ? `file:${patch.file_path}`
          : '',
    is_pinned: false,
    title: null,
    mime_type: null,
    metadata: null,
    created_by: null,
    created_at: now,
    updated_at: now,
    ...patch,
  } as Link;
}

describe('link display KB routing', () => {
  it('routes path-addressed KB refs and leaves opaque document/unit refs unrouted', () => {
    expect(routeForKnowledgeRefUri('agor://kb/global/guides/architecture.md')).toBe(
      '/kb/global/guides/architecture.md'
    );
    expect(routeForKnowledgeRefUri('agor://kb/team/runbooks/one%20two.md')).toBe(
      '/kb/team/runbooks/one%20two.md'
    );
    expect(routeForKnowledgeRefUri('agor://kb/global')).toBe('/kb/global');
    expect(
      routeForKnowledgeRefUri('agor://kb/document/0190a000-0000-7000-8000-0000000000aa')
    ).toBeNull();
    expect(
      routeForKnowledgeRefUri('agor://kb/unit/0190a000-0000-7000-8000-0000000000bb')
    ).toBeNull();
  });

  it('maps routable KB refs to SPA targets without inventing routes for opaque refs', () => {
    expect(targetForLinkDisplay({ refUri: 'agor://kb/global/readme.md' })).toEqual({
      href: '/kb/global/readme.md',
      navigation: 'spa',
    });
    expect(targetForLinkDisplay({ refUri: 'agor://kb/document/0190a000' })).toBeNull();
  });

  it('keeps KB document refs visible even when they are not directly routable', () => {
    const refUri = 'agor://kb/document/0190a000-0000-7000-8000-0000000000aa';
    const item = linkToDisplayItem(
      makeLink({
        link_id: 'link-kb-doc' as Link['link_id'],
        kind: 'kb_ref',
        source: 'parsed',
        ref_uri: refUri,
        target_key: normalizeRefTargetKey(refUri),
      })
    );

    expect(item).toMatchObject({
      name: 'KB document 0190a000',
      category: 'knowledge',
      refUri,
      href: undefined,
    });
  });
});

describe('link display merge and sort', () => {
  it('provides compact row names without duplicate type prefixes', () => {
    expect(getCompactLinkDisplayName({ name: 'Issue: preset-io/agor#92', category: 'issue' })).toBe(
      'preset-io/agor#92'
    );
    expect(getCompactLinkDisplayName({ name: 'PR: preset-io/agor#1692', category: 'pr' })).toBe(
      'preset-io/agor#1692'
    );
    expect(getCompactLinkDisplayName({ name: 'URL: docs', category: 'url' })).toBe('docs');
    expect(getCompactLinkDisplayName({ name: 'File: spec.pdf', category: 'pdf' })).toBe('spec.pdf');
  });

  it('sorts pinned items first, then alphabetically by display name', () => {
    const items: LinkDisplayItem[] = [
      item('z', 'Zebra', false),
      item('beta', 'beta', true),
      item('alpha', 'Alpha', true),
      item('middle', 'Middle', false),
    ];

    expect(sortLinkDisplayItems(items).map((entry) => entry.name)).toEqual([
      'Alpha',
      'beta',
      'Middle',
      'Zebra',
    ]);
  });

  it('merges branch issue/PR links with session links and dedupes by target key', () => {
    const branch = {
      issue_url: 'https://github.com/preset-io/agor/issues/92',
      pull_request_url: 'https://github.com/preset-io/agor/pull/1692',
    } as Branch;
    const links = [
      makeLink({
        link_id: 'link-duplicate-pr' as Link['link_id'],
        kind: 'pr',
        source: 'parsed',
        url: 'https://github.com/preset-io/agor/pull/1692#discussion',
        target_key: normalizeUrlTargetKey('https://github.com/preset-io/agor/pull/1692'),
        title: 'Pinned PR discussion',
        is_pinned: true,
      }),
      makeLink({
        link_id: 'link-docs' as Link['link_id'],
        kind: 'url',
        source: 'parsed',
        url: 'https://example.com/docs',
      }),
    ];

    const items = buildLinkDisplayItems({ branch, links });

    expect(items.map((entry) => entry.name)).toEqual([
      'Pinned PR discussion',
      'Issue: preset-io/agor#92',
      'URL: docs',
    ]);
    expect(items).toHaveLength(3);
    expect(items[0]).toMatchObject({ isPinned: true, kind: 'pr' });
  });

  it('prefers persisted branch rows over synthetic branch refs when pin state is equal', () => {
    const branch = {
      issue_url: 'https://github.com/preset-io/agor/issues/92',
    } as Branch;
    const links = [
      makeLink({
        link_id: 'link-branch-issue' as Link['link_id'],
        branch_id: 'branch-1' as Link['branch_id'],
        session_id: null,
        kind: 'issue',
        source: 'manual',
        url: 'https://github.com/preset-io/agor/issues/92',
        title: 'Tracked issue',
      }),
    ];

    const items = buildLinkDisplayItems({ branch, links });

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      name: 'Tracked issue',
      linkId: 'link-branch-issue',
      ownerScope: 'branch',
    });
  });
});

describe('link display categories', () => {
  it('infers neutral file categories and glyph labels from MIME type and extension', () => {
    expect(getLinkDisplayCategory({ filePath: '/uploads/spec.pdf' })).toBe('pdf');
    expect(getLinkDisplayCategory({ mimeType: 'text/markdown', filePath: '/uploads/readme' })).toBe(
      'markdown'
    );
    expect(getLinkDisplayCategory({ filePath: '/uploads/data.csv' })).toBe('csv');
    expect(getLinkDisplayGlyphLabel('pdf')).toBe('PDF');
    expect(getLinkDisplayGlyphLabel('knowledge')).toBe('KB');
  });

  it('provides exploration-compatible pill labels without coupling to row markup', () => {
    expect(getLinkDisplayPillLabel('issue')).toBe('Issue');
    expect(getLinkDisplayPillLabel('pr')).toBe('PR');
    expect(getLinkDisplayPillLabel('knowledge')).toBe('Knowledge');
    expect(getLinkDisplayPillLabel('url')).toBe('Saved URL');
    expect(getLinkDisplayPillLabel('image')).toBe('Image');
    expect(getLinkDisplayPillLabel('document')).toBe('Doc');
    expect(getLinkDisplayPillLabel('spreadsheet')).toBe('XLS');
    expect(getLinkDisplayPillLabel('csv')).toBe('CSV');
    expect(getLinkDisplayPillLabel('markdown')).toBe('MD');
  });

  it('renders uploaded file rows with useful labels but no preview href', () => {
    const filePath = '/home/agor/.agor/uploads/tenant/session/spec.pdf';
    const item = linkToDisplayItem(
      makeLink({
        link_id: 'link-file' as Link['link_id'],
        kind: 'document',
        source: 'upload',
        file_path: filePath,
        target_key: `file:${filePath}`,
      })
    );

    expect(item).toMatchObject({
      name: 'File: spec.pdf',
      category: 'pdf',
      filePath,
      href: undefined,
    });
    expect(getLinkDisplaySecondaryLabel(item as LinkDisplayItem)).toBe('spec.pdf');
    expect(getLinkDisplaySecondaryLabel(item as LinkDisplayItem)).not.toContain('/home/agor');
  });

  it('uses MIME type as a safe secondary label for uploaded files when present', () => {
    const item = linkToDisplayItem(
      makeLink({
        link_id: 'link-markdown' as Link['link_id'],
        kind: 'document',
        source: 'upload',
        file_path: '/home/agor/.agor/uploads/tenant/session/notes.md',
        mime_type: 'text/markdown',
      })
    );

    expect(getLinkDisplaySecondaryLabel(item as LinkDisplayItem)).toBe('text/markdown');
  });
});

function item(key: string, name: string, isPinned: boolean): LinkDisplayItem {
  return {
    key,
    name,
    targetKey: `target:${key}`,
    category: 'url',
    ownerScope: 'session',
    isPinned,
  };
}
