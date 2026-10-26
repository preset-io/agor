import { useCallback, useState, useSyncExternalStore } from 'react';
import { readLocalStorageJson, writeLocalStorageJson } from '../../hooks/localStorageJson';
import { getRouterBasename } from '../../utils/uiRoutes';

export type BoardView = 'tree' | 'board';
export type BoardTreeTab = 'sessions' | 'content' | 'comments';
export type BranchSort = 'alpha' | 'recent';
export interface BoardViewPreferences {
  view: BoardView;
  tab: BoardTreeTab;
  sort: BranchSort;
  expanded: Record<string, boolean>;
  scrollTop: number;
}
const DEFAULTS: BoardViewPreferences = {
  view: 'tree',
  tab: 'sessions',
  sort: 'alpha',
  expanded: {},
  scrollTop: 0,
};
const CHANGE_EVENT = 'agor:board-view-preferences';
const memoryFallback = new Map<string, string>();

/** Local navigation only. Board UUIDs partition tenant-owned work; the origin and
 * mount path additionally isolate workspaces served by the same browser. Never
 * stores entity content or writes the shared Board/board-objects services. */
export function boardViewPreferenceKey(workspace: string, userId: string, boardId: string) {
  return `agor:board-view:v1:${JSON.stringify([workspace, userId, boardId])}`;
}
export function parseBoardViewPreferences(raw: unknown): BoardViewPreferences {
  if (!raw || typeof raw !== 'object') return DEFAULTS;
  const value = raw as Partial<BoardViewPreferences>;
  return {
    view: value.view === 'board' ? 'board' : 'tree',
    tab: value.tab === 'content' || value.tab === 'comments' ? value.tab : 'sessions',
    sort: value.sort === 'recent' ? 'recent' : 'alpha',
    expanded: Object.fromEntries(
      Object.entries(value.expanded ?? {}).filter(([, v]) => typeof v === 'boolean')
    ),
    scrollTop:
      typeof value.scrollTop === 'number' && Number.isFinite(value.scrollTop)
        ? Math.max(0, value.scrollTop)
        : 0,
  };
}

export function useBoardViewPreferences(userId?: string, boardId?: string) {
  const [ephemeral, setEphemeral] = useState(DEFAULTS);
  const key =
    userId && boardId ? boardViewPreferenceKey(getRouterBasename(), userId, boardId) : null;
  // Snapshots are stable strings. A key change reads the new partition during
  // render, not an effect later (which could flash or write the old user's state).
  const subscribe = useCallback(
    (notify: () => void) => {
      const storage = (event: StorageEvent) => {
        if (!event.key || event.key === key) {
          if (key) memoryFallback.delete(key);
          notify();
        }
      };
      const local = (event: Event) => {
        if ((event as CustomEvent).detail === key) notify();
      };
      window.addEventListener('storage', storage);
      window.addEventListener(CHANGE_EVENT, local);
      return () => {
        window.removeEventListener('storage', storage);
        window.removeEventListener(CHANGE_EVENT, local);
      };
    },
    [key]
  );
  const snapshot = useCallback(() => {
    try {
      return key ? (memoryFallback.get(key) ?? window.localStorage.getItem(key)) : null;
    } catch {
      return key ? (memoryFallback.get(key) ?? null) : null;
    }
  }, [key]);
  const raw = useSyncExternalStore(subscribe, snapshot, () => null);
  let parsed: unknown;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    parsed = null;
  }
  const preferences = parseBoardViewPreferences(parsed);
  const update = useCallback(
    (patch: Partial<BoardViewPreferences>) => {
      if (!key) {
        setEphemeral((previous) => ({ ...previous, ...patch }));
        return;
      }
      let previous = parseBoardViewPreferences(readLocalStorageJson(key, DEFAULTS));
      const fallback = memoryFallback.get(key);
      if (fallback) {
        try {
          previous = parseBoardViewPreferences(JSON.parse(fallback));
        } catch {
          /* use defaults */
        }
      }
      const next = { ...previous, ...patch };
      if (!writeLocalStorageJson(key, next)) memoryFallback.set(key, JSON.stringify(next));
      else memoryFallback.delete(key);
      window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: key }));
    },
    [key]
  );
  return [key ? preferences : ephemeral, update] as const;
}
