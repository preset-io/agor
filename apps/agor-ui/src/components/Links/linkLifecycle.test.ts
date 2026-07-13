import type { AgorClient, Link } from '@agor-live/client';
import { describe, expect, it, vi } from 'vitest';
import type { LinkDisplayItem } from './linkDisplay';
import { getManualLinkTarget, updateLinkDisplayItem } from './linkLifecycle';

const sessionItem: LinkDisplayItem = {
  key: 'link:source',
  linkId: 'source',
  name: 'Issue: openai/codex#21295',
  targetKey: 'url:https://github.com/openai/codex/issues/21295',
  category: 'issue',
  kind: 'issue',
  source: 'parsed',
  ownerScope: 'session',
  isPinned: false,
  url: 'https://github.com/openai/codex/issues/21295',
};

describe('link lifecycle helpers', () => {
  it('infers supported manual link targets', () => {
    expect(getManualLinkTarget('https://github.com/openai/codex/pull/42')).toMatchObject({
      kind: 'pr',
      url: 'https://github.com/openai/codex/pull/42',
    });
    expect(getManualLinkTarget('agor://kb/team/runbook.md')).toEqual({
      kind: 'kb_ref',
      url: null,
      ref_uri: 'agor://kb/team/runbook.md',
      file_path: null,
    });
    expect(() => getManualLinkTarget('javascript:alert(1)')).toThrow(
      'Only http:// and https:// links are supported'
    );
  });

  it('patches an existing link directly without a redundant read', async () => {
    const updated = { link_id: sessionItem.linkId, title: 'Readable issue' } as Link;
    const patch = vi.fn(async () => updated);
    const get = vi.fn();
    const client = {
      service: vi.fn(() => ({ get, patch })),
    } as unknown as AgorClient;

    await expect(
      updateLinkDisplayItem({
        client,
        item: sessionItem,
        title: 'Readable issue',
      })
    ).resolves.toBe(updated);

    expect(get).not.toHaveBeenCalled();
    expect(patch).toHaveBeenCalledWith(sessionItem.linkId, { title: 'Readable issue' });
  });
});
