import type { AgorClient, Link } from '@agor-live/client';
import { describe, expect, it, vi } from 'vitest';
import type { LinkDisplayItem } from './linkDisplay';
import { getLinkPinActionLabel, toggleLinkDisplayItemPinned } from './linkPinning';

const branchIssue: LinkDisplayItem = {
  key: 'branch:issue',
  name: 'Issue: preset-io/agor#154',
  targetKey: 'url:https://github.com/preset-io/agor/issues/154',
  category: 'issue',
  kind: 'issue',
  source: 'branch',
  ownerScope: 'branch',
  isPinned: false,
  url: 'https://github.com/preset-io/agor/issues/154',
  href: 'https://github.com/preset-io/agor/issues/154',
  navigation: 'external',
};

describe('toggleLinkDisplayItemPinned', () => {
  it('materializes and pins a derived branch link', async () => {
    const created = { link_id: 'link-1', is_pinned: true } as Link;
    const create = vi.fn(async () => created);
    const client = { service: () => ({ create }) } as unknown as AgorClient;

    await expect(
      toggleLinkDisplayItemPinned({ client, item: branchIssue, branchId: 'branch-1' })
    ).resolves.toBe(created);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        branch_id: 'branch-1',
        source: 'manual',
        kind: 'issue',
        is_pinned: true,
        url: branchIssue.url,
      })
    );
  });

  it('patches an existing link', async () => {
    const item = { ...branchIssue, linkId: 'link-1', isPinned: true };
    const patched = { link_id: 'link-1', is_pinned: false } as Link;
    const patch = vi.fn(async () => patched);
    const client = { service: () => ({ patch }) } as unknown as AgorClient;

    await expect(toggleLinkDisplayItemPinned({ client, item, branchId: 'branch-1' })).resolves.toBe(
      patched
    );
    expect(patch).toHaveBeenCalledWith('link-1', { is_pinned: false });
  });
});

describe('getLinkPinActionLabel', () => {
  it.each([
    [branchIssue, {}, 'Pin preset-io/agor#154'],
    [{ ...branchIssue, isPinned: true }, {}, 'Unpin preset-io/agor#154'],
    [branchIssue, { available: false }, 'Pin unavailable for preset-io/agor#154'],
    [
      { ...branchIssue, isPinned: true },
      { available: false },
      'Unpin unavailable for preset-io/agor#154',
    ],
  ])('includes the compact link name', (item, options, expected) => {
    expect(getLinkPinActionLabel(item, options)).toBe(expected);
  });
});
