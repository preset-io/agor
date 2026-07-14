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
vi.mock('./linkPromotion', () => ({ promoteLinkDisplayItem: mocks.promote }));

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

  it('runs different promotion rows concurrently while suppressing a duplicate row action', async () => {
    const first = deferred<Link>();
    const second = deferred<Link>();
    mocks.promote.mockImplementation(({ item: value }: { item: LinkDisplayItem }) =>
      value.linkId === 'l1' ? first.promise : second.promise
    );
    const client = {} as AgorClient;
    const { result } = renderHook(() => useLinkMutations({ client, branchId: 'b1' }));
    const selection = { destination: 'branch' as const, branchId: 'b1' };

    let firstAction!: Promise<boolean>;
    let secondAction!: Promise<boolean>;
    act(() => {
      firstAction = result.current.promoteLink(item('l1'), selection);
      void result.current.promoteLink(item('l1'), selection);
      secondAction = result.current.promoteLink(item('l2'), selection);
    });

    expect(mocks.promote).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(result.current.lifecycleBusyKeys).toEqual(new Set(['l1', 'l2'])));

    first.resolve(resultLink('l1'));
    await act(async () => firstAction);
    expect(result.current.lifecycleBusyKeys).toEqual(new Set(['l2']));

    second.resolve(resultLink('l2'));
    await act(async () => secondAction);
    expect(result.current.lifecycleBusyKeys.size).toBe(0);
  });

  it('adds an existing promotion destination without removing the source link', async () => {
    const source = { ...resultLink('source'), branch_id: null, session_id: 's1' } as Link;
    const destination = resultLink('destination');
    agorStore.getState().applyKnownLinkCreatedResult(source);
    agorStore.getState().applyKnownLinkCreatedResult(destination);
    mocks.promote.mockResolvedValue(destination);
    const client = {} as AgorClient;
    const { result } = renderHook(() => useLinkMutations({ client, branchId: 'b1' }));

    await act(() =>
      result.current.promoteLink(item('source'), { destination: 'branch', branchId: 'b1' })
    );

    expect(agorStore.getState().linkById.get('source')).toEqual(source);
    expect(agorStore.getState().linkById.get('destination')).toEqual(destination);
    expect(mocks.showSuccess).toHaveBeenCalledWith('Link promoted');
  });
});
