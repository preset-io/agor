import type { Branch, Link } from '@agor-live/client';
import { normalizeUrlTargetKey } from '@agor-live/client';
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
  matchesLinkCategoryTab,
} from './linkOrganizer';
import { makeTestLink as makeLink } from './testUtils';

const KNOWLEDGE_DOCUMENT_ID = '0190a000-0000-7000-8000-0000000000aa';

describe('link display helpers', () => {
  it('routes path-addressed and document-ID KB refs but rejects unit refs', () => {
    expect(routeForKnowledgeRefUri('agor://kb/global/guides/architecture.md')).toBe(
      '/kb/global/guides/architecture.md'
    );
    expect(routeForKnowledgeRefUri('agor://kb/team/runbooks/one%20two.md')).toBe(
      '/kb/team/runbooks/one%20two.md'
    );
    expect(routeForKnowledgeRefUri(`agor://kb/document/${KNOWLEDGE_DOCUMENT_ID}`)).toBe(
      `/kb/_document/${KNOWLEDGE_DOCUMENT_ID}`
    );
    expect(routeForKnowledgeRefUri('agor://kb/document/pages/notes')).toBeNull();
    expect(routeForKnowledgeRefUri('agor://kb/unit/0190a000')).toBeNull();
  });

  it('routes Knowledge URI grammar case-insensitively without folding path case', () => {
    expect(routeForKnowledgeRefUri('  AGOR://KB/Team/Runbook.md  ')).toBe('/kb/Team/Runbook.md');
    expect(
      routeForKnowledgeRefUri(`AGOR://KB/DOCUMENT/${KNOWLEDGE_DOCUMENT_ID.toUpperCase()}`)
    ).toBe(`/kb/_document/${KNOWLEDGE_DOCUMENT_ID}`);
    expect(routeForKnowledgeRefUri('AGOR://KB/UNIT/0190a000')).toBeNull();
  });

  it('only creates navigable targets for safe web URLs or routed KB refs', () => {
    expect(targetForLinkDisplay({ refUri: 'agor://kb/global/readme.md' })).toEqual({
      href: '/kb/global/readme.md',
      navigation: 'spa',
    });
    expect(targetForLinkDisplay({ refUri: `agor://kb/document/${KNOWLEDGE_DOCUMENT_ID}` })).toEqual(
      {
        href: `/kb/_document/${KNOWLEDGE_DOCUMENT_ID}`,
        navigation: 'spa',
      }
    );
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
      'Link: docs',
    ]);
    expect(items).toHaveLength(3);
    expect(items[0]).toMatchObject({ isPinned: true, kind: 'pr' });
  });

  it('keeps case-distinct file target keys visible', () => {
    const upper = '/uploads/Report.pdf';
    const lower = '/uploads/report.pdf';
    const items = buildLinkDisplayItems({
      links: [
        makeLink({
          link_id: 'link-report-upper' as Link['link_id'],
          kind: 'document',
          source: 'upload',
          file_path: upper,
          target_key: `file:${upper}`,
          title: 'Report.pdf',
        }),
        makeLink({
          link_id: 'link-report-lower' as Link['link_id'],
          kind: 'document',
          source: 'upload',
          file_path: lower,
          target_key: `file:${lower}`,
          title: 'report.pdf',
        }),
      ],
    });

    expect(items.map((entry) => entry.name).sort()).toEqual(['Report.pdf', 'report.pdf']);
    expect(items).toHaveLength(2);
  });

  it('keeps case-distinct URL paths visible', () => {
    const upper = 'https://example.com/Report';
    const lower = 'https://example.com/report';
    const items = buildLinkDisplayItems({
      links: [
        makeLink({
          link_id: 'link-url-upper' as Link['link_id'],
          kind: 'url',
          source: 'manual',
          url: upper,
          target_key: normalizeUrlTargetKey(upper),
        }),
        makeLink({
          link_id: 'link-url-lower' as Link['link_id'],
          kind: 'url',
          source: 'manual',
          url: lower,
          target_key: normalizeUrlTargetKey(lower),
        }),
      ],
    });

    expect(items).toHaveLength(2);
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
    expect(getCompactLinkDisplayName({ name: 'Saved URL: Legacy docs', category: 'url' })).toBe(
      'Legacy docs'
    );
    expect(getLinkDisplaySecondaryLabel(file)).toBe('spec.pdf');
    expect(getLinkCategoryCounts(items)).toEqual({
      all: 4,
      files: 1,
      links: 1,
      knowledge: 1,
      issues: 1,
    });
    expect(matchesLinkCategoryTab(items[0], 'links')).toBe(true);
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
