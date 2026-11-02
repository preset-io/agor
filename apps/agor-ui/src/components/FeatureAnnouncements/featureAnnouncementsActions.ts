import type { FeatureAnnouncementAgorPage, User } from '@agor-live/client';
import { useCallback } from 'react';
import { useMCPCatalogModal } from '../../contexts/MCPCatalogModalContext';
import { readLocalStorageJson } from '../../hooks/localStorageJson';
import { useAppNavigation } from '../../hooks/useAppNavigation';
import { recentBoardsStorageKey } from '../../hooks/useRecentBoards';
import { useFeatureAnnouncements } from './FeatureAnnouncementsContext';

/** Every release in full; agor.live later. */
export const ALL_RELEASE_NOTES_URL = 'https://github.com/preset-io/agor/blob/main/CHANGELOG.md';

/** "Oct 28": release dates are calendar days, so read them in UTC. */
export const formatReleaseDate = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });

/** The board the user is on or last visited, else their main board. */
export function currentOrRecentBoardId(user: User | null | undefined): string | undefined {
  const recent = readLocalStorageJson<unknown>(recentBoardsStorageKey(user?.user_id), []);
  const first = Array.isArray(recent) ? recent.find((id) => typeof id === 'string') : undefined;
  return first ?? user?.preferences?.mainBoardId;
}

/** Opens one of the fixed places in Agor an announcement button can point at. */
export function useOpenAgorPage(user: User | null) {
  const navigation = useAppNavigation();
  const catalog = useMCPCatalogModal();
  const shell = useFeatureAnnouncements()?.shell;
  return useCallback(
    (target: FeatureAnnouncementAgorPage) => {
      switch (target) {
        case 'board': {
          const boardId = currentOrRecentBoardId(user);
          if (boardId) navigation.goToBoard(boardId);
          else navigation.goHome();
          return;
        }
        case 'teammates':
          return navigation.goToTeammates();
        case 'mcp':
          return catalog?.openCatalog();
        case 'models':
          return shell?.openModelSettings();
        case 'integrations':
          return shell?.openWorkspaceSettings('gateway');
        case 'artifacts':
          return shell?.openWorkspaceSettings('artifacts');
      }
    },
    [user, navigation, catalog, shell]
  );
}
