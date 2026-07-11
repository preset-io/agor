import type { Link } from '@agor-live/client';
import { describe, expect, it } from 'vitest';
import { groupRenderableLinksByMessageId } from './messageLinks';
import { makeTestLink } from './testUtils';

const link = (overrides: Partial<Link>) =>
  makeTestLink({
    source_message_id: 'message-1',
    source: 'parsed',
    url: 'https://example.com',
    ...overrides,
  });

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
