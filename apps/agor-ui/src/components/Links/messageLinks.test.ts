import type { Link } from '@agor-live/client';
import { describe, expect, it } from 'vitest';
import { groupRenderableLinksByMessageId } from './messageLinks';

function link(overrides: Partial<Link>): Link {
  return {
    link_id: 'link-1',
    branch_id: null,
    session_id: 'session-1',
    source_message_id: 'message-1',
    kind: 'url',
    source: 'parsed',
    url: 'https://example.com',
    ref_uri: null,
    file_path: null,
    target_key: 'url:https://example.com/',
    is_pinned: false,
    title: null,
    mime_type: null,
    metadata: null,
    created_by: null,
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-07-01T00:00:00.000Z',
    ...overrides,
  } as Link;
}

describe('groupRenderableLinksByMessageId', () => {
  it('groups uploaded files and parsed references while excluding unrelated links', () => {
    const parsedKb = link({
      link_id: 'kb-1',
      kind: 'kb_ref',
      url: null,
      ref_uri: 'agor://kb/orgs/preset/pr-review',
      target_key: 'ref:agor://kb/orgs/preset/pr-review',
    });
    const upload = link({
      link_id: 'upload-1',
      kind: 'image',
      source: 'upload',
      url: null,
      file_path: 'image.png',
      target_key: 'file:image.png',
    });
    const manual = link({ link_id: 'manual-1', source: 'manual' });

    expect(groupRenderableLinksByMessageId([parsedKb, upload, manual]).get('message-1')).toEqual([
      parsedKb,
      upload,
    ]);
  });
});
