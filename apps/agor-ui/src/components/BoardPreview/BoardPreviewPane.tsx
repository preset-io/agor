import { type AgorClient, isTeammate, type User } from '@agor-live/client';
import {
  AimOutlined,
  BranchesOutlined,
  CloseOutlined,
  FullscreenExitOutlined,
  FullscreenOutlined,
  MessageOutlined,
} from '@ant-design/icons';
import { Button, Flex, Skeleton, Tooltip, Typography, theme } from 'antd';
import { forwardRef, lazy, Suspense, useMemo } from 'react';
import { useBoardViewContext } from '../../contexts/BoardViewContext';
import type { BoardPreviewTarget } from '../../hooks/useBoardPreview';
import { useAgorStore } from '../../store/agorStore';
import { makeBranchSelector } from '../../store/selectors';
import {
  BOARD_FILE_ICONS,
  boardFileIconColor,
  boardFileStatus,
  boardFileTypeLabel,
} from '../../utils/boardFiles';
import { teammateLabel } from '../../utils/teammateLabels';
import { BranchDetailsPreview, branchPreviewStatus } from './BranchDetailsPreview';
import { KnowledgeDocPreview } from './KnowledgeDocPreview';
import { UploadPreview } from './UploadPreview';

// Sandpack stays out of the shell bundle until an artifact is previewed.
const ArtifactPreview = lazy(() =>
  import('./ArtifactPreview').then((module) => ({ default: module.ArtifactPreview }))
);

interface BoardPreviewSources {
  client: AgorClient | null;
  user: User | null | undefined;
  /** The conversation on screen, marked as current in the item's conversations. */
  currentSessionId?: string | null;
}

/**
 * The header and body for each kind of item, shared by the pane and the
 * phone's bottom sheet. `boardItem` is the card Show on board pans to;
 * `sourceSessionId` is the conversation it came from, when the reader can see
 * it; `body` is null once the item is gone.
 */
export function useBoardPreviewContent(
  target: BoardPreviewTarget,
  { client, user, currentSessionId }: BoardPreviewSources
) {
  const { token } = theme.useToken();
  const branch = useAgorStore(
    useMemo(() => makeBranchSelector(target.kind === 'branch' ? target.id : undefined), [target])
  );
  switch (target.kind) {
    case 'branch':
      return {
        icon: <BranchesOutlined style={{ color: token.colorTextSecondary }} />,
        title: branch ? (isTeammate(branch) ? teammateLabel(branch) : branch.name) : 'Branch',
        meta: ['Branch', branch && branchPreviewStatus(branch)].filter(Boolean).join(' · '),
        boardItem: branch ? { id: branch.branch_id, kind: 'branch' as const } : undefined,
        sourceSessionId: undefined,
        body: branch && (
          <BranchDetailsPreview
            branch={branch}
            client={client}
            user={user}
            currentSessionId={currentSessionId}
          />
        ),
      };
    case 'artifact':
    case 'document':
    case 'upload': {
      const { item } = target;
      return {
        icon: (
          <span style={{ color: boardFileIconColor(item.kind, token) }}>
            {BOARD_FILE_ICONS[item.kind]}
          </span>
        ),
        title: item.name,
        meta: [boardFileTypeLabel(item.kind), boardFileStatus(item)].filter(Boolean).join(' · '),
        boardItem:
          target.kind === 'artifact' ? { id: target.id, kind: 'artifact' as const } : undefined,
        sourceSessionId: typeof item.source === 'object' ? item.source.session_id : undefined,
        body:
          target.kind === 'artifact' ? (
            <Suspense fallback={<Skeleton active style={{ padding: token.paddingMD }} />}>
              <ArtifactPreview key={target.id} client={client} artifactId={target.id} />
            </Suspense>
          ) : target.kind === 'document' ? (
            <KnowledgeDocPreview client={client} documentId={target.id} />
          ) : (
            <UploadPreview key={target.ref} uploadRef={target.ref} item={item} />
          ),
      };
    }
  }
}

interface BoardPreviewPaneProps {
  target: BoardPreviewTarget;
  client: AgorClient | null;
  user: User | null | undefined;
  /** The conversation on screen, marked as current in the item's conversations. */
  currentSessionId?: string | null;
  fullScreen: boolean;
  /** Absent when the window is too narrow for a split: the preview stays full screen. */
  onToggleFullScreen?: () => void;
  /** Branches pan with the id alone; artifacts say so. */
  onShowOnBoard: (id: string, kind?: 'artifact') => void;
  onClose: () => void;
}

/**
 * The preview beside the main area: a header with the item's title, type and
 * status and its actions, over the item itself. A labelled region; Escape
 * inside it closes the preview.
 */
export const BoardPreviewPane = forwardRef<HTMLElement, BoardPreviewPaneProps>(
  function BoardPreviewPane(
    {
      target,
      client,
      user,
      currentSessionId,
      fullScreen,
      onToggleFullScreen,
      onShowOnBoard,
      onClose,
    },
    ref
  ) {
    const { token } = theme.useToken();
    const { icon, title, meta, boardItem, sourceSessionId, body } = useBoardPreviewContent(target, {
      client,
      user,
      currentSessionId,
    });
    // "Open conversation" for items from a conversation that Chat is not already showing.
    const boardView = useBoardViewContext();
    const conversationShown = boardView?.view === 'chat' && sourceSessionId === currentSessionId;
    const openConversation =
      boardView && sourceSessionId && !conversationShown
        ? () => boardView.openConversation(sourceSessionId)
        : undefined;

    const hasActions = !!onToggleFullScreen || !!openConversation || !!boardItem;

    return (
      <section
        ref={ref}
        tabIndex={-1}
        aria-label={`Preview: ${title}`}
        onKeyDown={(event) => {
          if (event.key !== 'Escape' || event.defaultPrevented) return;
          event.stopPropagation();
          onClose();
        }}
        style={{
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          background: token.colorBgContainer,
          outline: 'none',
        }}
      >
        <Flex
          vertical
          gap={token.marginXS}
          style={{
            flexShrink: 0,
            padding: `${token.paddingXS}px ${token.paddingSM}px`,
            borderBottom: `1px solid ${token.colorBorderSecondary}`,
          }}
        >
          <Flex align="center" gap={token.marginXS}>
            <span aria-hidden style={{ display: 'flex' }}>
              {icon}
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <Typography.Text strong ellipsis={{ tooltip: title }} style={{ display: 'block' }}>
                {title}
              </Typography.Text>
              <Typography.Text
                type="secondary"
                ellipsis
                style={{ display: 'block', fontSize: token.fontSizeSM }}
              >
                {meta}
              </Typography.Text>
            </div>
            <Tooltip title="Close preview">
              <Button
                type="text"
                size="small"
                aria-label="Close preview"
                icon={<CloseOutlined />}
                onClick={onClose}
              />
            </Tooltip>
          </Flex>
          {/* On their own row, so the title keeps the width and the labels stay. */}
          {hasActions && (
            <Flex gap={token.marginXS} wrap>
              {onToggleFullScreen && (
                <Button
                  size="small"
                  icon={fullScreen ? <FullscreenExitOutlined /> : <FullscreenOutlined />}
                  onClick={onToggleFullScreen}
                >
                  {fullScreen ? 'Exit full screen' : 'Open full screen'}
                </Button>
              )}
              {openConversation && (
                <Button size="small" icon={<MessageOutlined />} onClick={openConversation}>
                  Open conversation
                </Button>
              )}
              {boardItem && (
                <Button
                  size="small"
                  icon={<AimOutlined />}
                  onClick={() =>
                    boardItem.kind === 'artifact'
                      ? onShowOnBoard(boardItem.id, 'artifact')
                      : onShowOnBoard(boardItem.id)
                  }
                >
                  Show on board
                </Button>
              )}
            </Flex>
          )}
        </Flex>
        <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
          {body || (
            <Typography.Text
              type="secondary"
              style={{ display: 'block', padding: token.paddingMD }}
            >
              No longer available
            </Typography.Text>
          )}
        </div>
      </section>
    );
  }
);
