import type { AgorClient, Session } from '@agor-live/client';
import { useCallback, useEffect, useMemo } from 'react';
import { type AgorState, agorStore, shallow, useStoreWithEqualityFn } from '../store/agorStore';
import { boardIdForSession } from '../utils/boardIdForSession';
import { useStableCallback } from './useStableCallback';
import { useUserLocalStorage } from './useUserLocalStorage';

/** `selectedId` is always one of `ids`, or null. */
export interface SessionTabsState {
  ids: string[];
  selectedId: string | null;
}

const EMPTY_TABS: SessionTabsState = { ids: [], selectedId: null };

type IsShown = (id: string) => boolean;

/**
 * A tab shows only while its session is loaded and on this board. The others
 * stay saved: they may just not be loaded yet, or their branch may move back.
 */
export const isSessionTabShown = (
  state: Pick<AgorState, 'sessionById' | 'branchById'>,
  id: string,
  boardId: string | null
) => !!boardId && boardIdForSession(state.sessionById.get(id), state.branchById) === boardId;

export function openSessionTab(state: SessionTabsState, id: string): SessionTabsState {
  if (state.selectedId === id && state.ids.includes(id)) return state;
  return { ids: state.ids.includes(id) ? state.ids : [...state.ids, id], selectedId: id };
}

/** Closing the selected tab selects its right neighbour among the shown tabs, else its left one. */
export function closeSessionTab(
  state: SessionTabsState,
  id: string,
  isShown: IsShown = () => true
): SessionTabsState {
  if (!state.ids.includes(id)) return state;
  const ids = state.ids.filter((tabId) => tabId !== id);
  if (state.selectedId !== id) return { ids, selectedId: state.selectedId };
  const shown = state.ids.filter((tabId) => tabId === id || isShown(tabId));
  const index = shown.indexOf(id);
  return { ids, selectedId: shown[index + 1] ?? shown[index - 1] ?? null };
}

export function closeOtherSessionTabs(
  state: SessionTabsState,
  id: string,
  isShown: IsShown = () => true
): SessionTabsState {
  const ids = state.ids.filter((tabId) => tabId === id || !isShown(tabId));
  return { ids: ids.includes(id) ? ids : [...ids, id], selectedId: id };
}

/** Older or hand-edited storage must not break the panel. */
const normalize = (value: SessionTabsState): SessionTabsState => {
  if (!Array.isArray(value?.ids)) return EMPTY_TABS;
  if (value.selectedId && !value.ids.includes(value.selectedId)) {
    return { ...value, selectedId: null };
  }
  return value;
};

const EMPTY_SESSIONS: Session[] = [];

/** The live sessions behind tab ids, for the components that draw the tabs. */
export function useSessionTabSessions(ids: string[]): Session[] {
  const idsKey = ids.join(',');
  return useStoreWithEqualityFn(
    agorStore,
    useMemo(() => {
      const tabIds = idsKey ? idsKey.split(',') : [];
      return (s: AgorState) => {
        if (!tabIds.length) return EMPTY_SESSIONS;
        return tabIds.flatMap((id) => s.sessionById.get(id) ?? []);
      };
    }, [idsKey]),
    shallow
  );
}

interface SessionTabNavigation {
  /**
   * The session this window shows (its URL). Closing it navigates; the saved
   * selection is shared with other windows on the board, so it can differ.
   */
  displayedId: string | null | undefined;
  /** Shows the tab a close selected. */
  onSelect: (sessionId: string) => void;
  /** The shown tab closed and no other tab is shown. */
  onCloseLast: () => void;
}

/**
 * The sessions a person has open as tabs on one board, persisted per user per
 * board. `shownIds` are the tabs to draw (see `isSessionTabShown`); closing
 * the displayed tab navigates through `onSelect` / `onCloseLast`.
 */
export function useSessionTabs(
  client: AgorClient | null,
  userId: string | null | undefined,
  boardId: string | null,
  { displayedId, onSelect, onCloseLast }: SessionTabNavigation
) {
  const [stored, setStored] = useUserLocalStorage<SessionTabsState>(
    boardId ? userId : null,
    `session-tabs:${boardId}`,
    EMPTY_TABS
  );
  const state = normalize(stored);

  const idsKey = state.ids.join(',');
  const shownIds = useStoreWithEqualityFn(
    agorStore,
    useMemo(() => {
      const ids = idsKey ? idsKey.split(',') : [];
      return (s: AgorState) => ids.filter((id) => isSessionTabShown(s, id, boardId));
    }, [idsKey, boardId]),
    shallow
  );

  const isShown = useCallback(
    (id: string) => isSessionTabShown(agorStore.getState(), id, boardId),
    [boardId]
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

  /** Only a session on this board opens as a tab. */
  const open = useCallback(
    (id: string) => {
      if (isShown(id)) update((current) => openSessionTab(current, id));
    },
    [isShown, update]
  );

  const close = useStableCallback((id: string) => {
    const closesDisplayed = id === displayedId;
    // Closing the displayed tab selects its neighbour. If it is not a tab any
    // more, its archive event already moved the selection on.
    const next = update((current) =>
      closeSessionTab(
        closesDisplayed && current.ids.includes(id) ? { ...current, selectedId: id } : current,
        id,
        isShown
      )
    );
    if (!closesDisplayed) return;
    if (next.selectedId && isShown(next.selectedId)) onSelect(next.selectedId);
    else onCloseLast();
  });

  const closeOthers = useStableCallback((id: string) => {
    update((current) => closeOtherSessionTabs(current, id, isShown));
    if (id !== displayedId) onSelect(id);
  });

  // Archived and deleted sessions close their tab; one that is just not loaded keeps it.
  useEffect(() => {
    if (!client) return;
    const sessions = client.service('sessions');
    const drop = (session: Session) =>
      update((current) => closeSessionTab(current, session.session_id, isShown));
    const dropArchived = (session: Session) => {
      if (session.archived) drop(session);
    };
    sessions.on('patched', dropArchived);
    sessions.on('removed', drop);
    return () => {
      sessions.removeListener('patched', dropArchived);
      sessions.removeListener('removed', drop);
    };
  }, [client, isShown, update]);

  return { shownIds, selectedId: state.selectedId, open, close, closeOthers };
}
