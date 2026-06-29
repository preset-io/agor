import type { Branch, Link } from '@agor-live/client';
import { normalizeRefTargetKey, normalizeUrlTargetKey } from '@agor-live/client';
import { describe, expect, it } from 'vitest';
import {
  buildSessionLinkWidgetItems,
  hrefForRefUri,
  linkToSessionWidgetItem,
} from './sessionLinks';

const now = '2026-06-29T00:00:00.000Z';

function makeLink(patch: Partial<Link> & Pick<Link, 'link_id' | 'kind' | 'source'>): Link {
  return {
    branch_id: null,
    session_id: 'session-1' as Link['session_id'],
    source_message_id: null,
    target_key: patch.url
      ? normalizeUrlTargetKey(patch.url)
      : patch.ref_uri
        ? normalizeRefTargetKey(patch.ref_uri)
        : '',
    title: null,
    mime_type: null,
    metadata: null,
    created_by: null,
    created_at: now,
    updated_at: now,
    ...patch,
  } as Link;
}

describe('session link widget items', () => {
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
      }),
      makeLink({
        link_id: 'link-docs' as Link['link_id'],
        kind: 'url',
        source: 'parsed',
        url: 'https://example.com/docs',
      }),
    ];

    const items = buildSessionLinkWidgetItems({ branch, links });

    expect(items.map((item) => item.name)).toEqual([
      'Issue: preset-io/agor#92',
      'PR: preset-io/agor#1692',
      'URL: docs',
    ]);
    expect(items).toHaveLength(3);
  });

  it('turns path-addressed Knowledge refs into app routes', () => {
    const refUri = 'agor://kb/global/guides/architecture.md';
    const item = linkToSessionWidgetItem(
      makeLink({
        link_id: 'link-kb' as Link['link_id'],
        kind: 'kb_ref',
        source: 'parsed',
        ref_uri: refUri,
        target_key: normalizeRefTargetKey(refUri),
      })
    );

    expect(item).toMatchObject({
      name: 'KB: global/guides/architecture.md',
      href: '/kb/global/guides/architecture.md',
      refUri,
    });
  });

  it('keeps opaque KB document refs visible without inventing a broken route', () => {
    const refUri = 'agor://kb/document/0190a000-0000-7000-8000-0000000000aa';

    expect(hrefForRefUri(refUri)).toBeUndefined();
    expect(
      linkToSessionWidgetItem(
        makeLink({
          link_id: 'link-kb-doc' as Link['link_id'],
          kind: 'kb_ref',
          source: 'parsed',
          ref_uri: refUri,
          target_key: normalizeRefTargetKey(refUri),
        })
      )
    ).toMatchObject({
      name: 'KB document 0190a000',
      href: undefined,
      refUri,
    });
  });

  it('renders uploaded file rows with useful labels but no preview href', () => {
    const item = linkToSessionWidgetItem(
      makeLink({
        link_id: 'link-file' as Link['link_id'],
        kind: 'document',
        source: 'upload',
        file_path: '/tmp/uploads/spec.pdf',
        target_key: 'file:/tmp/uploads/spec.pdf',
      })
    );

    expect(item).toMatchObject({
      name: 'File: spec.pdf',
      filePath: '/tmp/uploads/spec.pdf',
    });
    expect(item?.href).toBeUndefined();
  });
});
