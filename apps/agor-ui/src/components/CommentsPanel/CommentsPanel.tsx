import type { AgorClient } from '@agor/core/api';
import type {
  BoardComment,
  BoardObject,
  CommentReaction,
  ReactionSummary,
  User,
  Worktree,
} from '@agor/core/types';
import { groupReactions, isThreadRoot } from '@agor/core/types';
import {
  AppstoreOutlined,
  BranchesOutlined,
  CheckOutlined,
  CloseOutlined,
  CommentOutlined,
  DeleteOutlined,
  SendOutlined,
  SmileOutlined,
  UndoOutlined,
} from '@ant-design/icons';
import {
  Badge,
  Button,
  Collapse,
  Input,
  List,
  Popover,
  Space,
  Spin,
  Tag,
  Tooltip,
  Typography,
  theme,
} from 'antd';
import EmojiPicker, { Theme } from 'emoji-picker-react';
import React, { useEffect, useMemo, useState } from 'react';
import { AgorAvatar } from '../AgorAvatar';
import { ZONE_CONTENT_OPACITY } from '../SessionCanvas/canvas/BoardObjectNodes';

const { Text, Title } = Typography;

export interface CommentsPanelProps {
  client: AgorClient | null;
  boardId: string;
  comments: BoardComment[];
  users: User[];
  currentUserId: string;
  boardObjects?: Record<string, BoardObject>; // For zone names
  worktreeById?: Map<string, Worktree>; // For worktree names
  loading?: boolean;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
  onSendComment: (content: string) => void;
  onReplyComment?: (parentId: string, content: string) => void;
  onResolveComment?: (commentId: string) => void;
  onToggleReaction?: (commentId: string, emoji: string) => void;
  onDeleteComment?: (commentId: string) => void;
  hoveredCommentId?: string | null;
  selectedCommentId?: string | null;
  width?: number | string; // Allow responsive width (default: 400)
}

type FilterMode = 'all' | 'active';

/**
 * Reaction display component - shows existing reactions as pills
 */
const ReactionDisplay: React.FC<{
  reactions: CommentReaction[];
  currentUserId: string;
  users: User[];
  onToggle: (emoji: string) => void;
}> = ({ reactions, currentUserId, users, onToggle }) => {
  const { token } = theme.useToken();
  const grouped: ReactionSummary = groupReactions(reactions);

  if (Object.keys(grouped).length === 0) {
    return null;
  }

  return (
    <Space size={token.sizeUnit}>
      {Object.entries(grouped).map(([emoji, userIds]) => {
        const hasReacted = userIds.includes(currentUserId);

        // Build tooltip content with list of users who reacted
        const reactedUsers = userIds
          .map((userId) => users.find((u) => u.user_id === userId))
          .filter(Boolean)
          .map((user) => user!.name || user!.email.split('@')[0]);

        const tooltipContent =
          reactedUsers.length > 0 ? reactedUsers.join(', ') : 'Anonymous users';

        return (
          <Tooltip key={emoji} title={tooltipContent}>
            <Button
              size="small"
              onClick={() => onToggle(emoji)}
              style={{
                borderRadius: 12,
                height: 24,
                padding: '0 8px',
                fontSize: 12,
                backgroundColor: hasReacted ? token.colorPrimaryBg : 'transparent',
                borderColor: token.colorBorder,
                color: token.colorText,
                transition: 'background-color 0.2s ease',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.backgroundColor = token.colorPrimaryBgHover;
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.backgroundColor = hasReacted
                  ? token.colorPrimaryBg
                  : 'transparent';
              }}
            >
              {emoji} {userIds.length}
            </Button>
          </Tooltip>
        );
      })}
    </Space>
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
          onEmojiClick={(emojiData) => {
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
      placement="right"
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
 * Individual reply component
 */
const ReplyItem: React.FC<{
  reply: BoardComment;
  users: User[];
  currentUserId: string;
  onToggleReaction?: (commentId: string, emoji: string) => void;
  onDelete?: (commentId: string) => void;
}> = ({ reply, users, currentUserId, onToggleReaction, onDelete }) => {
  const { token } = theme.useToken();
  const [replyHovered, setReplyHovered] = useState(false);
  const replyUser = users.find((u) => u.user_id === reply.created_by);
  const isReplyCurrentUser = reply.created_by === currentUserId;

  return (
    <List.Item
      style={{
        borderBottom: 'none',
        padding: '4px 0',
      }}
    >
      <div
        style={{ width: '100%', position: 'relative' }}
        onMouseEnter={() => setReplyHovered(true)}
        onMouseLeave={() => setReplyHovered(false)}
      >
        <List.Item.Meta
          avatar={<AgorAvatar>{replyUser?.emoji || '👤'}</AgorAvatar>}
          title={
            <Space size={4}>
              <Text strong style={{ fontSize: token.fontSizeSM }}>
                {replyUser?.name || 'Anonymous'}
              </Text>
              <Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
                {new Date(reply.created_at).toLocaleTimeString()}
              </Text>
            </Space>
          }
          description={
            <>
              <div style={{ marginTop: 2 }}>
                <Text style={{ fontSize: token.fontSizeSM }}>{reply.content}</Text>
              </div>
              {/* Reactions Row (always visible if reactions exist) */}
              {onToggleReaction && (reply.reactions || []).length > 0 && (
                <div style={{ marginTop: 4 }}>
                  <ReactionDisplay
                    reactions={reply.reactions || []}
                    currentUserId={currentUserId}
                    users={users}
                    onToggle={(emoji) => onToggleReaction(reply.comment_id, emoji)}
                  />
                </div>
              )}
            </>
          }
        />

        {/* Action buttons overlay (visible on hover) */}
        {replyHovered && (
          <div
            style={{
              position: 'absolute',
              top: 4,
              right: 0,
              backgroundColor: token.colorBgContainer,
              borderRadius: 4,
              padding: '2px',
              boxShadow: '0 2px 8px rgba(0, 0, 0, 0.15)',
            }}
          >
            <Space size="small">
              {onToggleReaction && (
                <EmojiPickerButton
                  onToggle={(emoji) => onToggleReaction(reply.comment_id, emoji)}
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
  isHighlighted?: boolean;
  scrollRef?: React.RefObject<HTMLDivElement>;
}> = ({
  comment,
  replies,
  users,
  currentUserId,
  onReply,
  onResolve,
  onToggleReaction,
  onDelete,
  isHighlighted,
  scrollRef,
}) => {
  const { token } = theme.useToken();
  const [showReplyInput, setShowReplyInput] = useState(false);
  const [isHovered, setIsHovered] = useState(false);
  const user = users.find((u) => u.user_id === comment.created_by);
  const isCurrentUser = comment.created_by === currentUserId;

  return (
    <List.Item
      ref={scrollRef}
      style={{
        borderBottom: `1px solid ${token.colorBorder}`,
        padding: isHighlighted ? `${token.paddingXS}px` : '8px 0',
        border: `2px solid ${isHighlighted ? token.colorPrimary : 'transparent'}`,
        borderRadius: token.borderRadiusLG,
        marginBottom: '4px',
        transition: 'all 0.2s ease',
      }}
    >
      <div
        style={{ width: '100%', position: 'relative' }}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
      >
        {/* Thread Root */}
        <List.Item.Meta
          avatar={<AgorAvatar>{user?.emoji || '👤'}</AgorAvatar>}
          title={
            <Space size={4}>
              <Text strong style={{ fontSize: token.fontSizeSM }}>
                {user?.name || 'Anonymous'}
              </Text>
              <Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
                {new Date(comment.created_at).toLocaleTimeString()}
              </Text>
              {comment.edited && (
                <Text type="secondary" style={{ fontSize: token.fontSizeSM, fontStyle: 'italic' }}>
                  (edited)
                </Text>
              )}
              {comment.resolved && (
                <Tag
                  color="success"
                  style={{ fontSize: token.fontSizeSM, lineHeight: '16px', margin: 0 }}
                >
                  Resolved
                </Tag>
              )}
            </Space>
          }
          description={
            <>
              <div style={{ marginTop: 4 }}>
                <Text style={{ fontSize: token.fontSizeSM }}>{comment.content}</Text>
              </div>
              {/* Reactions Row (always visible if reactions exist) */}
              {onToggleReaction && (comment.reactions || []).length > 0 && (
                <div style={{ marginTop: 4 }}>
                  <ReactionDisplay
                    reactions={comment.reactions || []}
                    currentUserId={currentUserId}
                    users={users}
                    onToggle={(emoji) => onToggleReaction(comment.comment_id, emoji)}
                  />
                </div>
              )}
            </>
          }
        />

        {/* Action buttons overlay (visible on hover) */}
        {isHovered && (
          <div
            style={{
              position: 'absolute',
              top: 4,
              right: 0,
              backgroundColor: token.colorBgContainer,
              borderRadius: 4,
              padding: '2px',
              boxShadow: '0 2px 8px rgba(0, 0, 0, 0.15)',
            }}
          >
            <Space size="small">
              {onToggleReaction && (
                <EmojiPickerButton
                  onToggle={(emoji) => onToggleReaction(comment.comment_id, emoji)}
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
              marginLeft: 16,
              marginTop: 8,
              borderLeft: `2px solid ${token.colorBorder}`,
              paddingLeft: 8,
            }}
          >
            <List
              dataSource={replies}
              renderItem={(reply) => (
                <ReplyItem
                  reply={reply}
                  users={users}
                  currentUserId={currentUserId}
                  onToggleReaction={onToggleReaction}
                  onDelete={onDelete}
                />
              )}
            />
          </div>
        )}

        {/* Reply Input */}
        {showReplyInput && onReply && (
          <div style={{ marginLeft: 32, marginTop: 4 }}>
            <Input.Search
              placeholder="Reply..."
              enterButton={<SendOutlined />}
              onSearch={(value) => {
                if (value.trim()) {
                  onReply(comment.comment_id, value);
                  setShowReplyInput(false);
                }
              }}
              autoFocus
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
  boardObjects = {},
  worktreeById,
  loading = false,
  collapsed = false,
  onToggleCollapse,
  onSendComment,
  onReplyComment,
  onResolveComment,
  onToggleReaction,
  onDeleteComment,
  hoveredCommentId,
  selectedCommentId,
  width = 400,
}) => {
  const { token } = theme.useToken();
  const [filter, setFilter] = useState<FilterMode>('active');
  const [commentInputValue, setCommentInputValue] = useState('');

  // Create refs for scroll-to-view
  const commentRefs = React.useRef<Record<string, React.RefObject<HTMLDivElement>>>({});

  // Separate thread roots from replies
  const threadRoots = useMemo(() => comments.filter((c) => isThreadRoot(c)), [comments]);

  const allReplies = useMemo(() => comments.filter((c) => !isThreadRoot(c)), [comments]);

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
      .filter((thread) => {
        if (filter === 'active' && thread.resolved) return false;
        return true;
      })
      .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
  }, [threadRoots, filter]);

  // Group filtered threads by scope (zone, worktree, or board-level)
  const groupedThreads = useMemo(() => {
    const groups: Record<
      string,
      {
        type: 'zone' | 'worktree' | 'board';
        label: string;
        color?: string;
        threads: BoardComment[];
      }
    > = {};

    for (const thread of filteredThreads) {
      let groupKey = 'board';
      let groupLabel = 'Board';
      let groupType: 'zone' | 'worktree' | 'board' = 'board';
      let groupColor: string | undefined;

      // Check if comment has relative positioning (pinned to zone/worktree)
      if (thread.position?.relative) {
        const { parent_id, parent_type } = thread.position.relative;

        if (parent_type === 'zone') {
          groupKey = `zone-${parent_id}`;
          const zone = boardObjects?.[`zone-${parent_id}`]; // Zone keys have 'zone-' prefix
          // Zone objects have a label field and color
          groupLabel = zone && 'label' in zone ? zone.label : 'Zone';
          groupColor = zone && 'color' in zone ? zone.color : undefined;
          groupType = 'zone';
        } else if (parent_type === 'worktree') {
          groupKey = `worktree-${parent_id}`;
          const worktree = worktreeById?.get(parent_id);
          groupLabel = worktree ? worktree.name : 'Unknown Worktree';
          groupType = 'worktree';
        }
      } else if (thread.worktree_id) {
        // Check for FK-based worktree attachment
        groupKey = `worktree-${thread.worktree_id}`;
        const worktree = worktreeById?.get(thread.worktree_id);
        groupLabel = worktree ? worktree.name : 'Unknown Worktree';
        groupType = 'worktree';
      }

      if (!groups[groupKey]) {
        groups[groupKey] = {
          type: groupType,
          label: groupLabel,
          color: groupColor,
          threads: [],
        };
      }

      groups[groupKey].threads.push(thread);
    }

    return groups;
  }, [filteredThreads, boardObjects, worktreeById]);

  // Sort groups by scope hierarchy: Board → Zones → Worktrees (larger to smaller)
  const sortedGroupEntries = useMemo(() => {
    const entries = Object.entries(groupedThreads);

    return entries.sort(([, a], [, b]) => {
      // Type priority: board (0) < zone (1) < worktree (2)
      const typeOrder = { board: 0, zone: 1, worktree: 2 };
      const aOrder = typeOrder[a.type];
      const bOrder = typeOrder[b.type];

      if (aOrder !== bOrder) {
        return aOrder - bOrder;
      }

      // Within same type, sort alphabetically by label
      return a.label.localeCompare(b.label);
    });
  }, [groupedThreads]);

  // Scroll to selected comment when it changes
  useEffect(() => {
    if (selectedCommentId && commentRefs.current[selectedCommentId]) {
      commentRefs.current[selectedCommentId]?.current?.scrollIntoView({
        behavior: 'smooth',
        block: 'center',
      });
    }
  }, [selectedCommentId]);

  // When collapsed, don't render anything
  if (collapsed) {
    return null;
  }

  // Expanded state - full panel
  return (
    <div
      style={{
        width,
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
          padding: 12,
          borderBottom: `1px solid ${token.colorBorder}`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <Space>
          <CommentOutlined />
          <Title level={5} style={{ margin: 0 }}>
            Comments
          </Title>
          <Badge
            count={filteredThreads.length}
            showZero={false}
            style={{ backgroundColor: token.colorPrimaryBgHover }}
          />
        </Space>
        {onToggleCollapse && (
          <Button
            type="text"
            size="small"
            icon={<CloseOutlined />}
            onClick={onToggleCollapse}
            danger
          />
        )}
      </div>

      {/* Filter Tabs */}
      <div
        style={{
          padding: 12,
          borderBottom: `1px solid ${token.colorBorder}`,
          backgroundColor: token.colorBgContainer,
        }}
      >
        <Space>
          <Button
            type={filter === 'active' ? 'primary' : 'default'}
            size="small"
            onClick={() => setFilter('active')}
          >
            Active
          </Button>
          <Button
            type={filter === 'all' ? 'primary' : 'default'}
            size="small"
            onClick={() => setFilter('all')}
          >
            All
          </Button>
        </Space>
      </div>

      {/* Thread List */}
      <div
        style={{
          flex: 1,
          overflow: 'auto',
          backgroundColor: token.colorBgLayout,
        }}
      >
        {loading ? (
          <div style={{ textAlign: 'center', padding: 32 }}>
            <Spin tip="Loading comments..." />
          </div>
        ) : Object.keys(groupedThreads).length === 0 ? (
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
          <Collapse
            defaultActiveKey={Object.keys(groupedThreads)}
            style={{ border: 'none', backgroundColor: 'transparent' }}
            items={sortedGroupEntries.map(([groupKey, group]) => ({
              key: groupKey,
              label: (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  {group.type === 'board' && (
                    <AppstoreOutlined style={{ fontSize: 14, color: token.colorPrimary }} />
                  )}
                  {group.type === 'zone' && group.color && (
                    <div
                      style={{
                        width: 12,
                        height: 12,
                        // Transparent fill matching zone background
                        backgroundColor: `${group.color}${Math.round(ZONE_CONTENT_OPACITY * 255)
                          .toString(16)
                          .padStart(2, '0')}`,
                        // Solid border in zone color
                        border: `1px solid ${group.color}`,
                        borderRadius: 2,
                      }}
                    />
                  )}
                  {group.type === 'worktree' && (
                    <BranchesOutlined style={{ fontSize: 14, color: token.colorPrimary }} />
                  )}
                  <Text strong>{group.label}</Text>
                  <Badge
                    count={group.threads.length}
                    style={{ backgroundColor: token.colorPrimaryBg }}
                  />
                </div>
              ),
              children: (
                <List
                  dataSource={group.threads}
                  renderItem={(thread) => {
                    // Create or get ref for this thread
                    if (!commentRefs.current[thread.comment_id]) {
                      commentRefs.current[thread.comment_id] = React.createRef<HTMLDivElement>();
                    }

                    const isHighlighted =
                      thread.comment_id === hoveredCommentId ||
                      thread.comment_id === selectedCommentId;

                    return (
                      <CommentThread
                        comment={thread}
                        replies={repliesByParent[thread.comment_id] || []}
                        users={users}
                        currentUserId={currentUserId}
                        onReply={onReplyComment}
                        onResolve={onResolveComment}
                        onToggleReaction={onToggleReaction}
                        onDelete={onDeleteComment}
                        isHighlighted={isHighlighted}
                        scrollRef={commentRefs.current[thread.comment_id]}
                      />
                    );
                  }}
                />
              ),
            }))}
          />
        )}
      </div>

      {/* Input Box for new top-level comment */}
      <div
        style={{
          padding: 12,
          borderTop: `1px solid ${token.colorBorder}`,
          backgroundColor: token.colorBgContainer,
        }}
      >
        <Input.Search
          placeholder="Add a comment..."
          enterButton={<SendOutlined />}
          value={commentInputValue}
          onChange={(e) => setCommentInputValue(e.target.value)}
          onSearch={(value) => {
            if (value.trim()) {
              onSendComment(value);
              setCommentInputValue('');
            }
          }}
        />
      </div>
    </div>
  );
};
