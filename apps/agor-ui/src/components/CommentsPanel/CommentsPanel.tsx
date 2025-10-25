import type { AgorClient } from '@agor/core/api';
import type { BoardComment, CommentReaction, ReactionSummary, User } from '@agor/core/types';
import { groupReactions, isThreadRoot } from '@agor/core/types';
import {
  CheckOutlined,
  CommentOutlined,
  DeleteOutlined,
  LeftOutlined,
  RightOutlined,
  SmileOutlined,
  UndoOutlined,
} from '@ant-design/icons';
import { Sender } from '@ant-design/x';
import { Avatar, Badge, Button, List, Popover, Space, Spin, Tag, Typography, theme } from 'antd';
import EmojiPicker, { Theme } from 'emoji-picker-react';
import type React from 'react';
import { useMemo, useState } from 'react';

const { Text } = Typography;

export interface CommentsPanelProps {
  client: AgorClient | null;
  boardId: string;
  comments: BoardComment[];
  users: User[];
  currentUserId: string;
  loading?: boolean;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
  onSendComment: (content: string) => void;
  onReplyComment?: (parentId: string, content: string) => void;
  onResolveComment?: (commentId: string) => void;
  onToggleReaction?: (commentId: string, emoji: string) => void;
  onDeleteComment?: (commentId: string) => void;
}

type FilterMode = 'all' | 'open' | 'mentions';

/**
 * Reaction display component - shows existing reactions as pills
 */
const ReactionDisplay: React.FC<{
  reactions: CommentReaction[];
  currentUserId: string;
  onToggle: (emoji: string) => void;
}> = ({ reactions, currentUserId, onToggle }) => {
  const grouped: ReactionSummary = groupReactions(reactions);

  if (Object.keys(grouped).length === 0) {
    return null;
  }

  return (
    <>
      {Object.entries(grouped).map(([emoji, userIds]) => {
        const hasReacted = userIds.includes(currentUserId);
        return (
          <Button
            key={emoji}
            size="small"
            type={hasReacted ? 'primary' : 'default'}
            onClick={() => onToggle(emoji)}
            style={{
              borderRadius: 12,
              height: 24,
              padding: '0 8px',
              fontSize: 12,
            }}
          >
            {emoji} {userIds.length}
          </Button>
        );
      })}
    </>
  );
};

/**
 * Emoji picker button component
 */
const EmojiPickerButton: React.FC<{
  onToggle: (emoji: string) => void;
}> = ({ onToggle }) => {
  const { token } = theme.useToken();
  const [pickerOpen, setPickerOpen] = useState(false);

  return (
    <Popover
      content={
        <EmojiPicker
          onEmojiClick={emojiData => {
            onToggle(emojiData.emoji);
            setPickerOpen(false);
          }}
          theme={Theme.DARK}
          width={350}
          height={400}
        />
      }
      trigger="click"
      open={pickerOpen}
      onOpenChange={setPickerOpen}
      placement="topLeft"
    >
      <Button
        type="text"
        size="small"
        icon={<SmileOutlined />}
        title="Add reaction"
        style={{ color: token.colorTextSecondary }}
      />
    </Popover>
  );
};

/**
 * Individual comment thread component (root + nested replies)
 */
const CommentThread: React.FC<{
  comment: BoardComment;
  replies: BoardComment[];
  users: User[];
  currentUserId: string;
  onReply?: (parentId: string, content: string) => void;
  onResolve?: (commentId: string) => void;
  onToggleReaction?: (commentId: string, emoji: string) => void;
  onDelete?: (commentId: string) => void;
}> = ({
  comment,
  replies,
  users,
  currentUserId,
  onReply,
  onResolve,
  onToggleReaction,
  onDelete,
}) => {
  const { token } = theme.useToken();
  const [showReplyInput, setShowReplyInput] = useState(false);
  const [isHovered, setIsHovered] = useState(false);
  const user = users.find(u => u.user_id === comment.created_by);
  const isCurrentUser = comment.created_by === currentUserId;

  return (
    <List.Item
      style={{
        borderBottom: `1px solid ${token.colorBorderSecondary}`,
        padding: '16px 0',
      }}
    >
      <div
        style={{ width: '100%', position: 'relative' }}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
      >
        {/* Thread Root */}
        <List.Item.Meta
          avatar={
            <Avatar style={{ backgroundColor: token.colorPrimary }}>{user?.emoji || '👤'}</Avatar>
          }
          title={
            <Space size={8}>
              <Text strong>{user?.name || 'Anonymous'}</Text>
              <Text type="secondary" style={{ fontSize: 12 }}>
                {new Date(comment.created_at).toLocaleTimeString()}
              </Text>
              {comment.edited && (
                <Text type="secondary" style={{ fontSize: 11, fontStyle: 'italic' }}>
                  (edited)
                </Text>
              )}
              {comment.resolved && (
                <Tag color="success" style={{ fontSize: 11, lineHeight: '16px', margin: 0 }}>
                  Resolved
                </Tag>
              )}
            </Space>
          }
          description={
            <div style={{ marginTop: 8 }}>
              <Text>{comment.content}</Text>
            </div>
          }
        />

        {/* Reactions Row (always visible if reactions exist) */}
        {onToggleReaction && (comment.reactions || []).length > 0 && (
          <div style={{ marginTop: 8 }}>
            <Space size="small">
              <ReactionDisplay
                reactions={comment.reactions || []}
                currentUserId={currentUserId}
                onToggle={emoji => onToggleReaction(comment.comment_id, emoji)}
              />
            </Space>
          </div>
        )}

        {/* Action buttons overlay (visible on hover) */}
        {isHovered && (
          <div
            style={{
              position: 'absolute',
              top: 8,
              right: 0,
              backgroundColor: token.colorBgContainer,
              borderRadius: 4,
              padding: '4px',
              boxShadow: '0 2px 8px rgba(0, 0, 0, 0.15)',
            }}
          >
            <Space size="small">
              {onToggleReaction && (
                <EmojiPickerButton
                  onToggle={emoji => onToggleReaction(comment.comment_id, emoji)}
                />
              )}
              {onReply && (
                <Button
                  type="text"
                  size="small"
                  icon={<CommentOutlined />}
                  onClick={() => setShowReplyInput(!showReplyInput)}
                  title="Reply"
                  style={{ color: token.colorTextSecondary }}
                />
              )}
              {onResolve && !comment.resolved && (
                <Button
                  type="text"
                  size="small"
                  icon={<CheckOutlined />}
                  onClick={() => onResolve(comment.comment_id)}
                  title="Resolve"
                  style={{ color: token.colorTextSecondary }}
                />
              )}
              {onResolve && comment.resolved && (
                <Button
                  type="text"
                  size="small"
                  icon={<UndoOutlined />}
                  onClick={() => onResolve(comment.comment_id)}
                  title="Reopen"
                  style={{ color: token.colorTextSecondary }}
                />
              )}
              {onDelete && isCurrentUser && (
                <Button
                  type="text"
                  size="small"
                  icon={<DeleteOutlined />}
                  onClick={() => onDelete(comment.comment_id)}
                  title="Delete"
                  danger
                  style={{ color: token.colorTextSecondary }}
                />
              )}
            </Space>
          </div>
        )}

        {/* Nested Replies (1 level deep) */}
        {replies.length > 0 && (
          <div
            style={{
              marginLeft: 48,
              marginTop: 12,
              borderLeft: `2px solid ${token.colorBorder}`,
              paddingLeft: 12,
            }}
          >
            <List
              dataSource={replies}
              renderItem={reply => {
                const replyUser = users.find(u => u.user_id === reply.created_by);
                const isReplyCurrentUser = reply.created_by === currentUserId;
                const [replyHovered, setReplyHovered] = useState(false);
                return (
                  <List.Item
                    style={{
                      borderBottom: 'none',
                      padding: '8px 0',
                    }}
                  >
                    <div
                      style={{ width: '100%', position: 'relative' }}
                      onMouseEnter={() => setReplyHovered(true)}
                      onMouseLeave={() => setReplyHovered(false)}
                    >
                      <List.Item.Meta
                        avatar={
                          <Avatar size="small" style={{ backgroundColor: token.colorPrimary }}>
                            {replyUser?.emoji || '👤'}
                          </Avatar>
                        }
                        title={
                          <Space size={4}>
                            <Text strong style={{ fontSize: 14 }}>
                              {replyUser?.name || 'Anonymous'}
                            </Text>
                            <Text type="secondary" style={{ fontSize: 11 }}>
                              {new Date(reply.created_at).toLocaleTimeString()}
                            </Text>
                          </Space>
                        }
                        description={
                          <div style={{ marginTop: 4 }}>
                            <Text style={{ fontSize: 14 }}>{reply.content}</Text>
                          </div>
                        }
                      />

                      {/* Reactions Row (always visible if reactions exist) */}
                      {onToggleReaction && (reply.reactions || []).length > 0 && (
                        <div style={{ marginTop: 4 }}>
                          <Space size="small">
                            <ReactionDisplay
                              reactions={reply.reactions || []}
                              currentUserId={currentUserId}
                              onToggle={emoji => onToggleReaction(reply.comment_id, emoji)}
                            />
                          </Space>
                        </div>
                      )}

                      {/* Action buttons overlay (visible on hover) */}
                      {replyHovered && (
                        <div
                          style={{
                            position: 'absolute',
                            top: 8,
                            right: 0,
                            backgroundColor: token.colorBgContainer,
                            borderRadius: 4,
                            padding: '4px',
                            boxShadow: '0 2px 8px rgba(0, 0, 0, 0.15)',
                          }}
                        >
                          <Space size="small">
                            {onToggleReaction && (
                              <EmojiPickerButton
                                onToggle={emoji => onToggleReaction(reply.comment_id, emoji)}
                              />
                            )}
                            {onDelete && isReplyCurrentUser && (
                              <Button
                                type="text"
                                size="small"
                                icon={<DeleteOutlined />}
                                onClick={() => onDelete(reply.comment_id)}
                                title="Delete"
                                danger
                                style={{ color: token.colorTextSecondary }}
                              />
                            )}
                          </Space>
                        </div>
                      )}
                    </div>
                  </List.Item>
                );
              }}
            />
          </div>
        )}

        {/* Reply Input */}
        {showReplyInput && onReply && (
          <div style={{ marginLeft: 48, marginTop: 8 }}>
            <Sender
              placeholder="Reply..."
              onSubmit={content => {
                onReply(comment.comment_id, content);
                setShowReplyInput(false);
              }}
              style={{
                backgroundColor: token.colorBgContainer,
              }}
            />
          </div>
        )}
      </div>
    </List.Item>
  );
};

/**
 * Main CommentsPanel component - permanent left sidebar with threading and reactions
 */
export const CommentsPanel: React.FC<CommentsPanelProps> = ({
  boardId,
  comments,
  users,
  currentUserId,
  loading = false,
  collapsed = false,
  onToggleCollapse,
  onSendComment,
  onReplyComment,
  onResolveComment,
  onToggleReaction,
  onDeleteComment,
}) => {
  const { token } = theme.useToken();
  const [filter, setFilter] = useState<FilterMode>('all');

  // Separate thread roots from replies
  const threadRoots = useMemo(() => comments.filter(c => isThreadRoot(c)), [comments]);

  const allReplies = useMemo(() => comments.filter(c => !isThreadRoot(c)), [comments]);

  // Group replies by parent
  const repliesByParent = useMemo(() => {
    const grouped: Record<string, BoardComment[]> = {};
    for (const reply of allReplies) {
      if (reply.parent_comment_id) {
        if (!grouped[reply.parent_comment_id]) {
          grouped[reply.parent_comment_id] = [];
        }
        grouped[reply.parent_comment_id].push(reply);
      }
    }
    return grouped;
  }, [allReplies]);

  // Apply filters to thread roots only
  const filteredThreads = useMemo(() => {
    return threadRoots
      .filter(thread => {
        if (filter === 'open' && thread.resolved) return false;
        if (filter === 'mentions' && !thread.mentions?.includes(currentUserId)) return false;
        return true;
      })
      .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
  }, [threadRoots, filter, currentUserId]);

  // When collapsed, don't render anything
  if (collapsed) {
    return null;
  }

  // Expanded state - full panel
  return (
    <div
      style={{
        width: 400,
        height: '100%',
        backgroundColor: token.colorBgContainer,
        borderRight: `1px solid ${token.colorBorder}`,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: 16,
          borderBottom: `1px solid ${token.colorBorder}`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <Space>
          <CommentOutlined />
          <Text strong>Comments</Text>
          <Badge count={filteredThreads.length} showZero={false} />
        </Space>
        {onToggleCollapse && (
          <Button type="text" size="small" onClick={onToggleCollapse}>
            Close
          </Button>
        )}
      </div>

      {/* Filter Tabs */}
      <div
        style={{
          padding: 16,
          borderBottom: `1px solid ${token.colorBorder}`,
          backgroundColor: token.colorBgContainer,
        }}
      >
        <Space>
          <Button
            type={filter === 'all' ? 'primary' : 'default'}
            size="small"
            onClick={() => setFilter('all')}
          >
            All
          </Button>
          <Button
            type={filter === 'open' ? 'primary' : 'default'}
            size="small"
            onClick={() => setFilter('open')}
          >
            Open
          </Button>
          <Button
            type={filter === 'mentions' ? 'primary' : 'default'}
            size="small"
            onClick={() => setFilter('mentions')}
          >
            Mentions
          </Button>
        </Space>
      </div>

      {/* Thread List */}
      <div
        style={{
          flex: 1,
          overflow: 'auto',
          padding: '0 16px',
          backgroundColor: token.colorBgLayout,
        }}
      >
        {loading ? (
          <div style={{ textAlign: 'center', padding: 32 }}>
            <Spin tip="Loading comments..." />
          </div>
        ) : filteredThreads.length === 0 ? (
          <div
            style={{
              textAlign: 'center',
              padding: 32,
              color: token.colorTextSecondary,
            }}
          >
            <CommentOutlined style={{ fontSize: 48, marginBottom: 16, opacity: 0.3 }} />
            <div>No comments yet</div>
            <div style={{ fontSize: 12, marginTop: 8 }}>Start a conversation about this board</div>
          </div>
        ) : (
          <List
            dataSource={filteredThreads}
            renderItem={thread => (
              <CommentThread
                comment={thread}
                replies={repliesByParent[thread.comment_id] || []}
                users={users}
                currentUserId={currentUserId}
                onReply={onReplyComment}
                onResolve={onResolveComment}
                onToggleReaction={onToggleReaction}
                onDelete={onDeleteComment}
              />
            )}
          />
        )}
      </div>

      {/* Input Box for new top-level comment */}
      <div
        style={{
          padding: 16,
          borderTop: `1px solid ${token.colorBorder}`,
          backgroundColor: token.colorBgContainer,
        }}
      >
        <Sender
          placeholder="Add a comment..."
          onSubmit={content => {
            onSendComment(content);
            return true; // Return true to clear the input
          }}
          style={{
            backgroundColor: token.colorBgContainer,
          }}
        />
      </div>
    </div>
  );
};
