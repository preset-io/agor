import type { AgorClient, Board, BoardComment, User, Worktree } from '@agor-live/client';
import { Alert } from 'antd';
import { useParams } from 'react-router-dom';
import { mapToArray } from '@/utils/mapHelpers';
import { CommentsPanel } from '../CommentsPanel';
import { MobileHeader } from './MobileHeader';

interface MobileCommentsPageProps {
  client: AgorClient | null;
  boardById: Map<string, Board>;
  commentById: Map<string, BoardComment>;
  worktreeById: Map<string, Worktree>;
  userById: Map<string, User>;
  currentUser?: User | null;
  onMenuClick?: () => void;
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
  worktreeById,
  userById,
  currentUser,
  onMenuClick,
  onSendComment,
  onReplyComment,
  onResolveComment,
  onToggleReaction,
  onDeleteComment,
}) => {
  const { boardId } = useParams<{ boardId: string }>();

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

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
      <MobileHeader
        title={`${board.icon || '📋'} ${board.name}`}
        showMenu
        user={currentUser}
        onMenuClick={onMenuClick}
      />
      <div style={{ flex: 1, overflow: 'hidden' }}>
        <CommentsPanel
          client={client}
          boardId={boardId}
          comments={boardComments}
          userById={userById}
          currentUserId={currentUser?.user_id || 'unknown'}
          boardObjects={board?.objects}
          worktreeById={worktreeById}
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
