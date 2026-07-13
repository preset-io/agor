import type { AgorClient, Link } from '@agor-live/client';
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { agorStore } from '../../store/agorStore';
import { deferred } from '../../testUtils';
import type { LinkDisplayItem } from './linkDisplay';
import { useLinkMutations } from './useLinkMutations';

const mocks = vi.hoisted(() => ({
  togglePinned: vi.fn(),
  promote: vi.fn(),
  showSuccess: vi.fn(),
  showError: vi.fn(),
}));

vi.mock('../../utils/message', () => ({
  useThemedMessage: () => ({ showSuccess: mocks.showSuccess, showError: mocks.showError }),
}));
vi.mock('./linkPinning', () => ({ toggleLinkDisplayItemPinned: mocks.togglePinned }));
vi.mock('./linkPromotion', () => ({ promoteLinkToTeammate: mocks.promote }));

function item(linkId: string): LinkDisplayItem {
  return { key: linkId, linkId, isPinned: false } as LinkDisplayItem;
}

function resultLink(linkId: string): Link {
  return { link_id: linkId, branch_id: 'b1', session_id: null } as Link;
}

describe('useLinkMutations concurrency', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    agorStore.getState().resetMaps();
  });

  it('runs different pin rows concurrently while suppressing a duplicate row action', async () => {
    const first = deferred<Link>();
    const second = deferred<Link>();
    mocks.togglePinned.mockImplementation(({ item: value }: { item: LinkDisplayItem }) =>
      value.linkId === 'l1' ? first.promise : second.promise
    );
    const client = {} as AgorClient;
    const { result } = renderHook(() => useLinkMutations({ client, branchId: 'b1' }));

    let firstAction!: Promise<void>;
    let secondAction!: Promise<void>;
    act(() => {
      firstAction = result.current.togglePinned(item('l1'));
      void result.current.togglePinned(item('l1'));
      secondAction = result.current.togglePinned(item('l2'));
    });

    expect(mocks.togglePinned).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(result.current.pinningKeys).toEqual(new Set(['l1', 'l2'])));

    first.resolve(resultLink('l1'));
    await act(async () => firstAction);
    expect(result.current.pinningKeys).toEqual(new Set(['l2']));

    second.resolve(resultLink('l2'));
    await act(async () => secondAction);
    expect(result.current.pinningKeys.size).toBe(0);
  });

  it('runs different teammate rows concurrently while suppressing a duplicate row action', async () => {
    const promotion = deferred<Link>();
    const removal = deferred<Link>();
    mocks.promote.mockReturnValue(promotion.promise);
    const remove = vi.fn(() => removal.promise);
    const client = { service: vi.fn(() => ({ remove })) } as unknown as AgorClient;
    agorStore.getState().applyKnownLinkCreatedResult({
      ...resultLink('teammate-copy'),
      metadata: { teammate_promotion: true },
    });
    const { result } = renderHook(() =>
      useLinkMutations({ client, branchId: 'b1', teammateBranchId: 'teammate' })
    );

    let promoteAction!: Promise<void>;
    let removeAction!: Promise<void>;
    act(() => {
      promoteAction = result.current.promoteToTeammate(item('source'));
      void result.current.promoteToTeammate(item('source'));
      removeAction = result.current.removeFromTeammate(item('other-source'), 'teammate-copy');
    });

    expect(mocks.promote).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(result.current.teammateBusyKeys).toEqual(new Set(['source', 'other-source']))
    );

    promotion.resolve(resultLink('promoted'));
    await act(async () => promoteAction);
    expect(result.current.teammateBusyKeys).toEqual(new Set(['other-source']));

    removal.resolve(resultLink('teammate-copy'));
    await act(async () => removeAction);
    expect(result.current.teammateBusyKeys.size).toBe(0);
  });

  it('refuses to remove a teammate-owned link without promotion provenance', async () => {
    const remove = vi.fn();
    const client = { service: vi.fn(() => ({ remove })) } as unknown as AgorClient;
    agorStore.getState().applyKnownLinkCreatedResult(resultLink('teammate-copy'));
    const { result } = renderHook(() => useLinkMutations({ client }));

    await act(() => result.current.removeFromTeammate(item('source'), 'teammate-copy'));

    expect(remove).not.toHaveBeenCalled();
    expect(mocks.showError).toHaveBeenCalledWith(
      'Only links created by teammate promotion can be removed'
    );
  });

  it('reports a promotion race as already available without claiming creation', async () => {
    mocks.promote.mockResolvedValue(resultLink('existing-teammate-link'));
    const client = { service: vi.fn() } as unknown as AgorClient;
    const { result } = renderHook(() => useLinkMutations({ client, teammateBranchId: 'teammate' }));

    await act(() => result.current.promoteToTeammate(item('source')));

    expect(mocks.showSuccess).toHaveBeenCalledWith('Already available on teammate');
  });
});
