import type { Branch, Link } from '@agor-live/client';
import { normalizeRefTargetKey, normalizeUrlTargetKey } from '@agor-live/client';
import { describe, expect, it } from 'vitest';
import {
  buildLinkDisplayItems,
  getCompactLinkDisplayName,
  getLinkDisplayCategory,
  getLinkDisplayGlyphLabel,
  getLinkDisplaySecondaryLabel,
  type LinkDisplayItem,
  linkToDisplayItem,
  routeForKnowledgeRefUri,
  sortLinkDisplayItems,
  targetForLinkDisplay,
} from './linkDisplay';
import {
  compareLinkDisplayItemsBySort,
  getLinkCategoryCounts,
  getLinkCategorySummary,
  matchesLinkCategoryTab,
} from './linkOrganizer';

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

describe('link display helpers', () => {
  it('routes path-addressed KB refs and rejects opaque document/unit refs', () => {
    expect(routeForKnowledgeRefUri('agor://kb/global/guides/architecture.md')).toBe(
      '/kb/global/guides/architecture.md'
    );
    expect(routeForKnowledgeRefUri('agor://kb/team/runbooks/one%20two.md')).toBe(
      '/kb/team/runbooks/one%20two.md'
    );
    expect(routeForKnowledgeRefUri('agor://kb/document/0190a000')).toBeNull();
    expect(routeForKnowledgeRefUri('agor://kb/unit/0190a000')).toBeNull();
  });

  it('only creates navigable targets for safe web URLs or routed KB refs', () => {
    expect(targetForLinkDisplay({ refUri: 'agor://kb/global/readme.md' })).toEqual({
      href: '/kb/global/readme.md',
      navigation: 'spa',
    });
    expect(targetForLinkDisplay({ url: 'https://example.com/docs?q=1#top' })).toEqual({
      href: 'https://example.com/docs?q=1#top',
      navigation: 'external',
    });
    expect(targetForLinkDisplay({ url: 'javascript:alert(1)' })).toBeNull();
    expect(targetForLinkDisplay({ url: '/relative/path' })).toBeNull();
  });

  it('merges branch issue/PR links with persisted links and dedupes by target key', () => {
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

  it('infers categories, compact names, secondary labels, and category counts', () => {
    const filePath = '/home/agor/.agor/uploads/tenant/session/spec.pdf';
    const file = linkToDisplayItem(
      makeLink({
        link_id: 'link-file' as Link['link_id'],
        kind: 'document',
        source: 'upload',
        file_path: filePath,
        target_key: `file:${filePath}`,
      })
    ) as LinkDisplayItem;
    const items: LinkDisplayItem[] = [
      item('web', 'URL: Docs', false),
      { ...item('kb', 'Knowledge', false), category: 'knowledge', refUri: 'agor://kb/team/doc.md' },
      file,
      { ...item('pr', 'PR', false), category: 'pr' },
    ];

    expect(getLinkDisplayCategory({ filePath })).toBe('pdf');
    expect(getLinkDisplayGlyphLabel('knowledge')).toBe('KB');
    expect(getCompactLinkDisplayName(items[0])).toBe('Docs');
    expect(getLinkDisplaySecondaryLabel(file)).toBe('spec.pdf');
    expect(getLinkCategoryCounts(items)).toEqual({
      all: 4,
      files: 1,
      links: 1,
      knowledge: 1,
      issues: 1,
    });
    expect(matchesLinkCategoryTab(items[0], 'links')).toBe(true);
    expect(getLinkCategorySummary(items)).toBe('1 file · 1 link · 1 knowledge · 1 issue/PR');
  });

  it('keeps pinned rows first under default and alternate sort orders', () => {
    const items: LinkDisplayItem[] = [
      { ...item('old-z', 'Zebra', false), createdAt: '2026-01-01T00:00:00.000Z' },
      { ...item('new-a', 'Alpha', false), createdAt: '2026-02-01T00:00:00.000Z' },
      { ...item('pinned-m', 'Middle', true), createdAt: '2025-01-01T00:00:00.000Z' },
    ];

    expect(sortLinkDisplayItems(items).map((entry) => entry.name)).toEqual([
      'Middle',
      'Alpha',
      'Zebra',
    ]);
    expect(
      [...items]
        .sort((a, b) => compareLinkDisplayItemsBySort(a, b, 'recent'))
        .map((entry) => entry.name)
    ).toEqual(['Middle', 'Alpha', 'Zebra']);
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
