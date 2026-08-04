import type {
  AgorClient,
  KnowledgeDocumentComment,
  KnowledgeDocumentHeading,
  User,
} from '@agor-live/client';
import {
  KNOWLEDGE_COMMENT_DOCUMENT_ANCHOR_LABEL,
  KNOWLEDGE_COMMENT_ORPHANED_ANCHOR_LABEL,
  resolveKnowledgeCommentAnchor,
} from '@agor-live/client';
import { DisconnectOutlined, FileTextOutlined, NumberOutlined } from '@ant-design/icons';
import { Alert, Button, Space, Tag, theme } from 'antd';
import { useCallback, useMemo } from 'react';
import { type CommentGroup, CommentsPanel } from '../CommentsPanel';
import type { KnowledgeCommentAnchorInput } from './useKnowledgeDocumentComments';

/** Groups sort by document → sections in reading order → orphaned. */
const SORT_RANK = { document: 0, section: 1, orphaned: 2 };

export interface KnowledgeCommentsPanelProps {
  client: AgorClient | null;
  comments: KnowledgeDocumentComment[];
  headings: readonly KnowledgeDocumentHeading[];
  userById: Map<string, User>;
  currentUserId: string;
  /** Section a new thread will anchor to; null anchors to the whole page. */
  pendingAnchor: KnowledgeCommentAnchorInput;
  onClearPendingAnchor: () => void;
  /** False for read-only viewers: threads stay visible, affordances do not. */
  canComment: boolean;
  loading?: boolean;
  error?: string | null;
  onClose?: () => void;
  onAddComment: (content: string, anchor: KnowledgeCommentAnchorInput) => void;
  onReplyComment: (parentCommentId: string, content: string) => void;
  onToggleResolved: (commentId: string) => void;
  onToggleReaction: (commentId: string, emoji: string) => void;
  onDeleteComment: (commentId: string) => void;
  selectedCommentId?: string | null;
  onSelectSection?: (slug: string) => void;
}

/**
 * Knowledge-flavoured wrapper over the shared CommentsPanel: threads are
 * grouped by the document section they are anchored to, resolved live against
 * the headings currently rendered.
 */
export const KnowledgeCommentsPanel: React.FC<KnowledgeCommentsPanelProps> = ({
  client,
  comments,
  headings,
  userById,
  currentUserId,
  pendingAnchor,
  onClearPendingAnchor,
  canComment,
  loading,
  error,
  onClose,
  onAddComment,
  onReplyComment,
  onToggleResolved,
  onToggleReaction,
  onDeleteComment,
  selectedCommentId,
  onSelectSection,
}) => {
  const { token } = theme.useToken();

  const headingOrder = useMemo(
    () => new Map(headings.map((heading, index) => [heading.slug, index])),
    [headings]
  );

  const resolveGroup = useCallback(
    (comment: KnowledgeDocumentComment): CommentGroup => {
      const anchor = resolveKnowledgeCommentAnchor(comment, headings);

      if (anchor.state === 'anchored' && anchor.slug) {
        return {
          key: `section-${anchor.slug}`,
          label: anchor.label || anchor.slug,
          icon: <NumberOutlined style={{ fontSize: 14, color: token.colorPrimary }} />,
          // Keep sections in reading order rather than alphabetical.
          sortRank:
            SORT_RANK.section + (headingOrder.get(anchor.slug) ?? 0) / (headings.length + 1),
        };
      }

      if (anchor.state === 'orphaned') {
        return {
          key: 'orphaned',
          label: KNOWLEDGE_COMMENT_ORPHANED_ANCHOR_LABEL,
          icon: <DisconnectOutlined style={{ fontSize: 14, color: token.colorWarning }} />,
          sortRank: SORT_RANK.orphaned,
        };
      }

      return {
        key: 'document',
        label: KNOWLEDGE_COMMENT_DOCUMENT_ANCHOR_LABEL,
        icon: <FileTextOutlined style={{ fontSize: 14, color: token.colorPrimary }} />,
        sortRank: SORT_RANK.document,
      };
    },
    [headings, headingOrder, token.colorPrimary, token.colorWarning]
  );

  const composerHint = pendingAnchor.anchor_slug ? (
    <Space size={4} wrap>
      <Tag
        icon={<NumberOutlined />}
        color="processing"
        closable
        onClose={onClearPendingAnchor}
        style={{ marginInlineEnd: 0 }}
      >
        {pendingAnchor.anchor_label || pendingAnchor.anchor_slug}
      </Tag>
      {onSelectSection && (
        <Button
          type="link"
          size="small"
          onClick={() => onSelectSection(pendingAnchor.anchor_slug as string)}
        >
          Show section
        </Button>
      )}
    </Space>
  ) : undefined;

  return (
    <>
      {error && (
        <Alert type="error" title="Could not load comments" description={error} showIcon banner />
      )}
      <CommentsPanel
        client={client}
        comments={comments}
        userById={userById}
        currentUserId={currentUserId}
        resolveGroup={resolveGroup}
        title="Comments"
        emptyDescription={
          canComment
            ? 'Hover a section heading to comment on it'
            : 'You need write access to this Knowledge space to comment'
        }
        composerHint={composerHint}
        loading={loading}
        onToggleCollapse={onClose}
        onSendComment={canComment ? (content) => onAddComment(content, pendingAnchor) : undefined}
        onReplyComment={canComment ? onReplyComment : undefined}
        onResolveComment={canComment ? onToggleResolved : undefined}
        onToggleReaction={canComment ? onToggleReaction : undefined}
        onDeleteComment={canComment ? onDeleteComment : undefined}
        selectedCommentId={selectedCommentId}
      />
    </>
  );
};
