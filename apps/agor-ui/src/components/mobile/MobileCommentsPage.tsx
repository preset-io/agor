import type { AgorClient } from '@agor/core/api';
import type { Board, BoardComment, User, Worktree } from '@agor/core/types';
import { Alert } from 'antd';
import { useParams } from 'react-router-dom';
import { CommentsPanel } from '../CommentsPanel';
import { MobileHeader } from './MobileHeader';

interface MobileCommentsPageProps {
  client: AgorClient | null;
  boards: Board[];
  comments: BoardComment[];
  worktreeById: Map<string, Worktree>;
  users: User[];
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
  boards,
  comments,
  worktreeById,
  users,
  currentUser,
  onMenuClick,
  onSendComment,
  onReplyComment,
  onResolveComment,
  onToggleReaction,
  onDeleteComment,
}) => {
  const { boardId } = useParams<{ boardId: string }>();

  const board = boards.find((b) => b.board_id === boardId);
  const boardComments = comments.filter((c) => c.board_id === boardId);

  if (!boardId) {
    return (
      <div style={{ padding: 16 }}>
        <Alert type="error" message="No board ID provided" />
      </div>
    );
  }

  if (!board) {
    return (
      <div style={{ padding: 16 }}>
        <Alert type="error" message="Board not found" />
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
          users={users}
          currentUserId={currentUser?.user_id || 'anonymous'}
          boardObjects={board?.objects}
          worktreeById={worktreeById}
          onSendComment={(content) => onSendComment(boardId, content)}
          onReplyComment={onReplyComment}
          onResolveComment={onResolveComment}
          onToggleReaction={onToggleReaction}
          onDeleteComment={onDeleteComment}
          width="100%" // Full width for mobile
        />
      </div>
    </div>
  );
};
