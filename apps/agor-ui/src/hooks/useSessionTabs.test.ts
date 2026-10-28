import { EventEmitter } from 'node:events';
import type { AgorClient, Branch, Session } from '@agor-live/client';
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_MAPS } from '../store/agorMaps';
import { agorStore } from '../store/agorStore';
import {
  closeOtherSessionTabs,
  closeSessionTab,
  openSessionTab,
  useSessionTabs,
} from './useSessionTabs';
import { userStorageKey } from './useUserLocalStorage';

const tabs = (ids: string[], selectedId: string | null = ids[0] ?? null) => ({ ids, selectedId });

describe('session tab state', () => {
  it('appends a newly opened session and selects it', () => {
    expect(openSessionTab(tabs(['a']), 'b')).toEqual(tabs(['a', 'b'], 'b'));
  });

  it('selects an already open session without duplicating or reordering it', () => {
    expect(openSessionTab(tabs(['a', 'b', 'c'], 'c'), 'a')).toEqual(tabs(['a', 'b', 'c'], 'a'));
  });

  it('selects the right neighbour when the selected tab closes, else the left one', () => {
    expect(closeSessionTab(tabs(['a', 'b', 'c'], 'b'), 'b')).toEqual(tabs(['a', 'c'], 'c'));
    expect(closeSessionTab(tabs(['a', 'b', 'c'], 'c'), 'c')).toEqual(tabs(['a', 'b'], 'b'));
  });

  it('keeps the selection when another tab closes', () => {
    expect(closeSessionTab(tabs(['a', 'b', 'c'], 'a'), 'c')).toEqual(tabs(['a', 'b'], 'a'));
  });

  it('closes the panel with the last tab', () => {
    expect(closeSessionTab(tabs(['a']), 'a')).toEqual(tabs([], null));
  });

  it('keeps only the chosen tab on close other tabs', () => {
    expect(closeOtherSessionTabs(tabs(['a', 'b', 'c'], 'a'), 'b')).toEqual(tabs(['b'], 'b'));
  });
});

describe('useSessionTabs', () => {
  const storageKey = userStorageKey('u1', 'session-tabs:board-1');
  const saved = () => JSON.parse(localStorage.getItem(storageKey) ?? 'null');

  /** Sessions `ids` loaded on `boardId` (each on its own branch). */
  const load = (boardId: string, ids: string[]) => {
    const { sessionById, branchById } = agorStore.getState();
    const sessions = new Map(sessionById);
    const branches = new Map(branchById);
    for (const id of ids) {
      sessions.set(id, { session_id: id, branch_id: `branch-${id}` } as Session);
      branches.set(`branch-${id}`, { branch_id: `branch-${id}`, board_id: boardId } as Branch);
    }
    agorStore.setState({ sessionById: sessions, branchById: branches });
  };

  /** `displayedId` is the session the window shows; it defaults to the saved selection. */
  const render = (
    state: { ids: string[]; selectedId: string | null },
    displayedId = state.selectedId
  ) => {
    localStorage.setItem(storageKey, JSON.stringify(state));
    const sessions = new EventEmitter();
    const client = { service: () => sessions } as unknown as AgorClient;
    const onSelect = vi.fn();
    const onCloseLast = vi.fn();
    const { result } = renderHook(() =>
      useSessionTabs(client, 'u1', 'board-1', { displayedId, onSelect, onCloseLast })
    );
    return { result, sessions, onSelect, onCloseLast };
  };

  afterEach(() => {
    localStorage.clear();
    agorStore.setState({ ...EMPTY_MAPS });
  });

  it('keeps saved tabs that are not loaded yet when the shown one closes', () => {
    // Cold load of /s/b: only b is in the store.
    load('board-1', ['b']);
    const { result, onCloseLast } = render(tabs(['a', 'b', 'c'], 'b'));
    expect(result.current.shownIds).toEqual(['b']);

    act(() => result.current.close('b'));
    expect(saved()).toEqual(tabs(['a', 'c'], null));
    expect(onCloseLast).toHaveBeenCalled();
  });

  it('navigates from the displayed tab when another window saved a different selection', () => {
    load('board-1', ['a', 'b', 'c']);
    // This window shows a; a second window on the board saved c as selected.
    const { result, onSelect } = render(tabs(['a', 'b', 'c'], 'c'), 'a');

    act(() => result.current.close('a'));
    expect(onSelect).toHaveBeenCalledWith('b');
    expect(saved()).toEqual(tabs(['b', 'c'], 'b'));
  });

  it('selects the neighbour when the selected tab is archived', () => {
    load('board-1', ['a', 'b', 'c']);
    const { result, sessions, onSelect } = render(tabs(['a', 'b', 'c'], 'b'));

    act(() => {
      sessions.emit('patched', { session_id: 'b', archived: true });
    });
    expect(saved()).toEqual(tabs(['a', 'c'], 'c'));

    // The shell then closes the vanished session and follows the selection.
    act(() => result.current.close('b'));
    expect(onSelect).toHaveBeenCalledWith('c');
    expect(saved()).toEqual(tabs(['a', 'c'], 'c'));
  });

  it('hides a tab whose branch moved to another board without dropping it', () => {
    load('board-1', ['a', 'b']);
    load('board-2', ['c']);
    const { result, onSelect } = render(tabs(['a', 'b', 'c'], 'b'));
    expect(result.current.shownIds).toEqual(['a', 'b']);

    act(() => result.current.close('b'));
    expect(onSelect).toHaveBeenCalledWith('a');
    expect(saved()).toEqual(tabs(['a', 'c'], 'a'));

    act(() => result.current.open('c'));
    expect(saved()).toEqual(tabs(['a', 'c'], 'a'));
  });
});
