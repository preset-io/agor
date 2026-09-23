import type { Session } from '@agor-live/client';
import type React from 'react';
import { useAgorStore } from '../../store/agorStore';
import { selectBoardById, selectBranchById } from '../../store/selectors';
import { getBoardEmoji } from '../BoardTile';
import { HomeBlock, HomeEmpty } from './HomeBlock';
import { HomeSessionRow } from './HomeSessionsSection';
import { useAwaitingSessions } from './useAwaitingSessions';

// Same cap as the mobile home's JumpBackInSection.
const NEEDS_YOU_LIMIT = 5;

interface HomeNeedsYouSectionProps {
  currentUserId?: string;
  onSessionClick: (sessionId: string) => void;
}

/** Rows subscribe to branches/boards only while something is waiting. */
const NeedsYouRows: React.FC<{
  sessions: Session[];
  onSessionClick: (sessionId: string) => void;
}> = ({ sessions, onSessionClick }) => {
  const branchById = useAgorStore(selectBranchById);
  const boardById = useAgorStore(selectBoardById);
  const visibleSessions = sessions.slice(0, NEEDS_YOU_LIMIT);
  const hiddenCount = sessions.length - visibleSessions.length;

  return (
    <HomeBlock label="Needs you" count={sessions.length} surface>
      {visibleSessions.map((session) => {
        const branch = branchById.get(session.branch_id);
        const board = branch?.board_id ? boardById.get(branch.board_id) : undefined;
        return (
          <HomeSessionRow
            key={session.session_id}
            session={session}
            branch={branch}
            board={board}
            boardEmoji={board ? getBoardEmoji(board, branchById) : undefined}
            showBranch
            showStateLabel
            onSessionClick={onSessionClick}
          />
        );
      })}
      {hiddenCount > 0 && <HomeEmpty>and {hiddenCount} more</HomeEmpty>}
    </HomeBlock>
  );
};

/** Sessions waiting on the user's reply or permission; renders nothing when none are. */
export const HomeNeedsYouSection: React.FC<HomeNeedsYouSectionProps> = ({
  currentUserId,
  onSessionClick,
}) => {
  const sessions = useAwaitingSessions(currentUserId);

  if (sessions.length === 0) return null;
  return <NeedsYouRows sessions={sessions} onSessionClick={onSessionClick} />;
};
