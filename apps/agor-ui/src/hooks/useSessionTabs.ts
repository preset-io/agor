import type { Session } from '@agor-live/client';
import { useCallback, useMemo } from 'react';
import { type AgorState, agorStore, shallow, useStoreWithEqualityFn } from '../store/agorStore';
import { useUserLocalStorage } from './useUserLocalStorage';

export interface SessionTabsState {
  ids: string[];
  selectedId: string | null;
}

const EMPTY_TABS: SessionTabsState = { ids: [], selectedId: null };

export function openSessionTab(state: SessionTabsState, id: string): SessionTabsState {
  if (state.selectedId === id && state.ids.includes(id)) return state;
  return { ids: state.ids.includes(id) ? state.ids : [...state.ids, id], selectedId: id };
}

/** Closing the selected tab selects its right neighbour, else its left one. */
export function closeSessionTab(state: SessionTabsState, id: string): SessionTabsState {
  const index = state.ids.indexOf(id);
  if (index === -1) return state;
  const ids = state.ids.filter((tabId) => tabId !== id);
  const selectedId =
    state.selectedId === id ? (ids[Math.min(index, ids.length - 1)] ?? null) : state.selectedId;
  return { ids, selectedId };
}

export function closeOtherSessionTabs(state: SessionTabsState, id: string): SessionTabsState {
  return { ids: state.ids.includes(id) ? [id] : [], selectedId: id };
}

/** Older or hand-edited storage must not break the panel. */
const normalize = (value: SessionTabsState): SessionTabsState =>
  Array.isArray(value?.ids) ? value : EMPTY_TABS;

/** Drops tabs whose session is gone (archived or deleted) before a close picks a neighbour. */
const withoutMissing = (state: SessionTabsState): SessionTabsState => {
  const { sessionById } = agorStore.getState();
  return { ...state, ids: state.ids.filter((id) => sessionById.has(id)) };
};

const EMPTY_SESSIONS: Session[] = [];

/**
 * The sessions a person has open as tabs on one board, persisted per user per
 * board. Tabs whose session is not in the store are left out of `sessions`.
 */
export function useSessionTabs(userId: string | null | undefined, boardId: string | null) {
  const [stored, setStored] = useUserLocalStorage<SessionTabsState>(
    boardId ? userId : null,
    `session-tabs:${boardId}`,
    EMPTY_TABS
  );
  const state = normalize(stored);

  const idsKey = state.ids.join(',');
  const sessions = useStoreWithEqualityFn(
    agorStore,
    useMemo(() => {
      const ids = idsKey ? idsKey.split(',') : [];
      return (s: AgorState) => {
        if (!ids.length) return EMPTY_SESSIONS;
        return ids.flatMap((id) => s.sessionById.get(id) ?? []);
      };
    }, [idsKey]),
    shallow
  );

  const update = useCallback(
    (apply: (state: SessionTabsState) => SessionTabsState) => {
      let next = EMPTY_TABS;
      setStored((current) => {
        next = apply(normalize(current));
        return next;
      });
      return next;
    },
    [setStored]
  );

  const open = useCallback(
    (id: string) => {
      update((current) => openSessionTab(current, id));
    },
    [update]
  );

  /** Returns the tab selected after closing. */
  const close = useCallback(
    (id: string) => update((current) => closeSessionTab(withoutMissing(current), id)).selectedId,
    [update]
  );

  const closeOthers = useCallback(
    (id: string) => {
      update((current) => closeOtherSessionTabs(current, id));
    },
    [update]
  );

  return { sessions, selectedId: state.selectedId, open, close, closeOthers };
}
