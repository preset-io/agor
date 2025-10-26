import type { AgorClient } from '@agor/core/api';
import type { BoardComment, CommentReaction, ReactionSummary, User, UUID } from '@agor/core/types';
import { groupReactions, isThreadRoot } from '@agor/core/types';
import { CommentOutlined, SmileOutlined } from '@ant-design/icons';
import { Sender } from '@ant-design/x';
import {
  Avatar,
  Badge,
  Button,
  Drawer,
  List,
  Popover,
  Space,
  Spin,
  Tag,
  Typography,
  theme,
} from 'antd';
import EmojiPicker, { Theme } from 'emoji-picker-react';
import type React from 'react';
import { useCallback, useMemo, useState } from 'react';

const { Title, Text } = Typography;

export interface CommentsDrawerProps {
  client: AgorClient | null;
  boardId: string;
  comments: BoardComment[];
  users: User[];
  currentUserId: string;
  loading?: boolean;
  open: boolean;
  onClose: () => void;
  onSendComment: (content: string) => void;
  onReplyComment?: (parentId: string, content: string) => void;
  onResolveComment?: (commentId: string) => void;
  onToggleReaction?: (commentId: string, emoji: string) => void;
  onDeleteComment?: (commentId: string) => void;
}

type FilterMode = 'all' | 'open' | 'mentions';

/**
 * Reaction bar component - displays and manages emoji reactions
 */
const ReactionBar: React.FC<{
  reactions: CommentReaction[];
  currentUserId: string;
  onToggle: (emoji: string) => void;
}> = ({ reactions, currentUserId, onToggle }) => {
  const { token } = theme.useToken();
  const [pickerOpen, setPickerOpen] = useState(false);

  const grouped: ReactionSummary = groupReactions(reactions);

  return (
    <Space size="small" style={{ marginTop: 8 }}>
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
          size="small"
          icon={<SmileOutlined />}
          style={{
            borderRadius: 12,
            height: 24,
            padding: '0 8px',
          }}
        />
      </Popover>
    </Space>
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
  const user = users.find(u => u.user_id === comment.created_by);
  const isCurrentUser = comment.created_by === currentUserId;

  return (
    <List.Item
      style={{
        borderBottom: `1px solid ${token.colorBorderSecondary}`,
        padding: '16px 0',
      }}
    >
      <div style={{ width: '100%' }}>
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

        {/* Reactions */}
        {onToggleReaction && (
          <ReactionBar
            reactions={comment.reactions || []}
            currentUserId={currentUserId}
            onToggle={emoji => onToggleReaction(comment.comment_id, emoji)}
          />
        )}

        {/* Actions */}
        <Space size="small" style={{ marginTop: 8 }}>
          {onReply && (
            <Button type="link" size="small" onClick={() => setShowReplyInput(!showReplyInput)}>
              Reply
            </Button>
          )}
          {onResolve && (
            <Button type="link" size="small" onClick={() => onResolve(comment.comment_id)}>
              {comment.resolved ? 'Reopen' : 'Resolve'}
            </Button>
          )}
          {onDelete && isCurrentUser && (
            <Button type="link" size="small" danger onClick={() => onDelete(comment.comment_id)}>
              Delete
            </Button>
          )}
        </Space>

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
                return (
                  <List.Item
                    style={{
                      borderBottom: 'none',
                      padding: '8px 0',
                    }}
                  >
                    <div style={{ width: '100%' }}>
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
                      {onToggleReaction && (
                        <ReactionBar
                          reactions={reply.reactions || []}
                          currentUserId={currentUserId}
                          onToggle={emoji => onToggleReaction(reply.comment_id, emoji)}
                        />
                      )}
                      {onDelete && isReplyCurrentUser && (
                        <Button
                          type="link"
                          size="small"
                          danger
                          onClick={() => onDelete(reply.comment_id)}
                          style={{ marginTop: 4, padding: 0 }}
                        >
                          Delete
                        </Button>
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
 * Main CommentsDrawer component with threading and reactions
 */
export const CommentsDrawer: React.FC<CommentsDrawerProps> = ({
  boardId,
  comments,
  users,
  currentUserId,
  loading = false,
  open,
  onClose,
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
        if (filter === 'mentions' && !thread.mentions?.includes(currentUserId as UUID))
          return false;
        return true;
      })
      .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
  }, [threadRoots, filter, currentUserId]);

  return (
    <Drawer
      title={
        <Space>
          <CommentOutlined />
          <span>Comments</span>
          <Badge count={filteredThreads.length} showZero={false} />
        </Space>
      }
      placement="left"
      width={500}
      open={open}
      onClose={onClose}
      styles={{
        body: {
          padding: 0,
          display: 'flex',
          flexDirection: 'column',
          height: '100%',
        },
      }}
    >
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
          onSubmit={content => onSendComment(content)}
          style={{
            backgroundColor: token.colorBgContainer,
          }}
        />
      </div>
    </Drawer>
  );
};
