import type { AgorClient, Link } from '@agor-live/client';
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { agorStore } from '../../store/agorStore';
import { deferred } from '../../testUtils';
import type { LinkDisplayItem } from './linkDisplay';
import { useLinkMutations } from './useLinkMutations';

const mocks = vi.hoisted(() => ({
  togglePinned: vi.fn(),
  move: vi.fn(),
  showSuccess: vi.fn(),
  showError: vi.fn(),
}));

vi.mock('../../utils/message', () => ({
  useThemedMessage: () => ({ showSuccess: mocks.showSuccess, showError: mocks.showError }),
}));
vi.mock('./linkPinning', () => ({ toggleLinkDisplayItemPinned: mocks.togglePinned }));
vi.mock('./linkMove', () => ({ moveLinkDisplayItem: mocks.move }));

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

  it('runs different move rows concurrently while suppressing a duplicate row action', async () => {
    const first = deferred<{ link: Link; previous_link: Link; merged: boolean }>();
    const second = deferred<{ link: Link; previous_link: Link; merged: boolean }>();
    mocks.move.mockImplementation(({ item: value }: { item: LinkDisplayItem }) =>
      value.linkId === 'l1' ? first.promise : second.promise
    );
    const client = {} as AgorClient;
    const { result } = renderHook(() => useLinkMutations({ client, branchId: 'b1' }));
    const selection = { destination: 'branch' as const, ownerId: 'b1' };

    let firstAction!: Promise<boolean>;
    let secondAction!: Promise<boolean>;
    act(() => {
      firstAction = result.current.moveLink(item('l1'), selection);
      void result.current.moveLink(item('l1'), selection);
      secondAction = result.current.moveLink(item('l2'), selection);
    });

    expect(mocks.move).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(result.current.lifecycleBusyKeys).toEqual(new Set(['l1', 'l2'])));

    first.resolve({ link: resultLink('l1'), previous_link: resultLink('l1'), merged: false });
    await act(async () => firstAction);
    expect(result.current.lifecycleBusyKeys).toEqual(new Set(['l2']));

    second.resolve({ link: resultLink('l2'), previous_link: resultLink('l2'), merged: false });
    await act(async () => secondAction);
    expect(result.current.lifecycleBusyKeys.size).toBe(0);
  });

  it('reconciles a move that coalesces into an existing destination link', async () => {
    const source = { ...resultLink('source'), branch_id: null, session_id: 's1' } as Link;
    const destination = resultLink('destination');
    agorStore.getState().applyKnownLinkCreatedResult(source);
    agorStore.getState().applyKnownLinkCreatedResult(destination);
    mocks.move.mockResolvedValue({ link: destination, previous_link: source, merged: true });
    const client = {} as AgorClient;
    const { result } = renderHook(() => useLinkMutations({ client, branchId: 'b1' }));

    await act(() =>
      result.current.moveLink(item('source'), { destination: 'branch', ownerId: 'b1' })
    );

    expect(agorStore.getState().linkById.has('source')).toBe(false);
    expect(agorStore.getState().linkById.get('destination')).toEqual(destination);
    expect(mocks.showSuccess).toHaveBeenCalledWith('Link moved');
  });
});
