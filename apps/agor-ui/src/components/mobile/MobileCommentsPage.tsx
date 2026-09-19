import type { AgorClient, Board, BoardComment, Branch, User } from '@agor-live/client';
import { Alert } from 'antd';
import { useNavigate, useParams } from 'react-router-dom';
import { mapToArray } from '@/utils/mapHelpers';
import { getBoardEmoji } from '../BoardTile';
import { CommentsPanel } from '../CommentsPanel';
import { mobilePageStyle } from './constants';
import { MobileHeader } from './MobileHeader';

interface MobileCommentsPageProps {
  client: AgorClient | null;
  boardById: Map<string, Board>;
  commentById: Map<string, BoardComment>;
  branchById: Map<string, Branch>;
  userById: Map<string, User>;
  currentUser?: User | null;
  /** Back to the surface the bell was tapped from (comments is a full-screen sub-view). */
  onBack?: () => void;
  onSendComment: (boardId: string, content: string) => void;
  onReplyComment?: (parentId: string, content: string) => void;
  onResolveComment?: (commentId: string) => void;
  onToggleReaction?: (commentId: string, emoji: string) => void;
  onDeleteComment?: (commentId: string) => void;
}

export const MobileCommentsPage: React.FC<MobileCommentsPageProps> = ({
  client,
  boardById,
  commentById,
  branchById,
  userById,
  currentUser,
  onBack,
  onSendComment,
  onReplyComment,
  onResolveComment,
  onToggleReaction,
  onDeleteComment,
}) => {
  const { boardId } = useParams<{ boardId: string }>();
  const navigate = useNavigate();

  const board = boardId ? boardById.get(boardId) : undefined;
  const boardComments = mapToArray(commentById).filter((c: BoardComment) => c.board_id === boardId);

  if (!boardId) {
    return (
      <div style={{ padding: 16 }}>
        <Alert type="error" title="No board ID provided" />
      </div>
    );
  }

  if (!board) {
    return (
      <div style={{ padding: 16 }}>
        <Alert type="error" title="Board not found" />
      </div>
    );
  }

  const boardSwitcher = {
    boards: Array.from(boardById.values())
      .filter((b) => !b.archived)
      .map((b) => ({ board_id: b.board_id, name: b.name, emoji: getBoardEmoji(b, branchById) })),
    currentBoardId: boardId,
    onSelect: (id: string) => navigate(`/m/comments/${id}`),
  };

  return (
    <div style={mobilePageStyle}>
      <MobileHeader
        title={board.name}
        onBack={onBack}
        boardSwitcher={boardSwitcher}
        onSearch={() => navigate('/m/search')}
      />
      <div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
        <CommentsPanel
          alwaysShowActions
          hideHeader
          client={client}
          boardId={boardId}
          comments={boardComments}
          userById={userById}
          currentUserId={currentUser?.user_id || 'unknown'}
          boardObjects={board?.objects}
          branchById={branchById}
          onSendComment={(content) => onSendComment(boardId, content)}
          onReplyComment={onReplyComment}
          onResolveComment={onResolveComment}
          onToggleReaction={onToggleReaction}
          onDeleteComment={onDeleteComment}
        />
      </div>
    </div>
  );
};
