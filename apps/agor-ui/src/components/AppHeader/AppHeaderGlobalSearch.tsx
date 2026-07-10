import type { Board, Branch } from '@agor-live/client';
import { memo } from 'react';
import { useAgorStore } from '../../store/agorStore';
import { selectArtifactById, selectMcpServerById, selectSessionById } from '../../store/selectors';
import { GlobalSearch } from '../GlobalSearch';

interface AppHeaderGlobalSearchProps {
  currentUserId?: string;
  branchById: Map<string, Branch>;
  boardById: Map<string, Board>;
  onSettingsClick?: () => void;
}

/**
 * Owns the entity maps that ONLY GlobalSearch consumes — sessions, artifacts and
 * MCP servers. `sessionById` in particular is the highest-churn slice in the
 * store (a patch per streamed token). Subscribing to it HERE, in a memo'd leaf,
 * means a session patch wakes only GlobalSearch — not the whole AppHeader and
 * its board switcher / presence facepile chrome. `branchById` and `boardById`
 * are read by other header chrome too, so they stay subscribed in AppHeader and
 * arrive as props (their references only change on the rarer branch/board
 * patches). GlobalSearch receives the exact same live maps as before.
 */
export const AppHeaderGlobalSearch = memo(function AppHeaderGlobalSearch({
  currentUserId,
  branchById,
  boardById,
  onSettingsClick,
}: AppHeaderGlobalSearchProps) {
  const sessionById = useAgorStore(selectSessionById);
  const artifactById = useAgorStore(selectArtifactById);
  const mcpServerById = useAgorStore(selectMcpServerById);

  return (
    <GlobalSearch
      currentUserId={currentUserId}
      sessionById={sessionById}
      branchById={branchById}
      artifactById={artifactById}
      boardById={boardById}
      mcpServerById={mcpServerById}
      onSettingsClick={onSettingsClick}
    />
  );
});
