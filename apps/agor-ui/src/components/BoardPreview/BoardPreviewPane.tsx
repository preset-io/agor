import { type AgorClient, isTeammate } from '@agor-live/client';
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

export interface BoardPreviewSummary {
  icon: React.ReactNode;
  title: string;
  /** "{type} · {status}". */
  meta: string;
  /** The conversation it came from, when the reader can see it. */
  sourceSessionId?: string;
  /** What "Show on board" pans to: branches and artifacts are cards on the board. */
  boardCard?: { kind: 'branch' | 'artifact'; id: string };
}

/** The header line for any preview: icon, title, type and status, and where it came from. */
export function useBoardPreviewSummary(target: BoardPreviewTarget): BoardPreviewSummary {
  const { token } = theme.useToken();
  const branchId = target.kind === 'branch' ? target.id : undefined;
  const branch = useAgorStore(useMemo(() => makeBranchSelector(branchId), [branchId]));
  if (target.kind === 'branch') {
    return {
      icon: <BranchesOutlined style={{ color: token.colorTextSecondary }} />,
      title: branch ? (isTeammate(branch) ? teammateLabel(branch) : branch.name) : 'Branch',
      meta: ['Branch', branch && branchPreviewStatus(branch)].filter(Boolean).join(' · '),
      boardCard: branch ? { kind: 'branch', id: branch.branch_id } : undefined,
    };
  }
  const { item } = target;
  return {
    icon: (
      <span style={{ color: boardFileIconColor(item.kind, token) }}>
        {BOARD_FILE_ICONS[item.kind]}
      </span>
    ),
    title: item.name,
    meta: [boardFileTypeLabel(item.kind), boardFileStatus(item)].filter(Boolean).join(' · '),
    sourceSessionId: typeof item.source === 'object' ? item.source.session_id : undefined,
    boardCard: target.kind === 'artifact' ? { kind: 'artifact', id: target.id } : undefined,
  };
}

/** The previewed item itself, shared by the desktop pane and the phone's bottom sheet. */
export const BoardPreviewBody: React.FC<{
  client: AgorClient | null;
  target: BoardPreviewTarget;
}> = ({ client, target }) => {
  const { token } = theme.useToken();
  const branchId = target.kind === 'branch' ? target.id : undefined;
  const branch = useAgorStore(useMemo(() => makeBranchSelector(branchId), [branchId]));
  switch (target.kind) {
    case 'artifact':
      return (
        <Suspense fallback={<Skeleton active style={{ padding: token.paddingMD }} />}>
          <ArtifactPreview key={target.id} client={client} artifactId={target.id} />
        </Suspense>
      );
    case 'document':
      return <KnowledgeDocPreview client={client} documentId={target.id} />;
    case 'upload':
      return <UploadPreview key={target.ref} uploadRef={target.ref} item={target.item} />;
    case 'branch':
      return branch ? (
        <BranchDetailsPreview branch={branch} />
      ) : (
        <Typography.Text type="secondary" style={{ display: 'block', padding: token.paddingMD }}>
          No longer available
        </Typography.Text>
      );
  }
};

interface BoardPreviewPaneProps {
  client: AgorClient | null;
  target: BoardPreviewTarget;
  fullScreen: boolean;
  /** Absent when the window is too narrow for a split: the preview stays full screen. */
  onToggleFullScreen?: () => void;
  onShowOnBoard: (id: string, kind: 'branch' | 'artifact') => void;
  /** Opens the item's conversation in Chat and keeps the preview. */
  onOpenConversation: (sessionId: string) => void;
  /** The conversation already on screen in Chat, which needs no "Open conversation". */
  shownSessionId?: string | null;
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
      client,
      target,
      fullScreen,
      onToggleFullScreen,
      onShowOnBoard,
      onOpenConversation,
      shownSessionId,
      onClose,
    },
    ref
  ) {
    const { token } = theme.useToken();
    const { icon, title, meta, sourceSessionId, boardCard } = useBoardPreviewSummary(target);
    const showsOpenConversation = !!sourceSessionId && sourceSessionId !== shownSessionId;
    const hasActions = !!onToggleFullScreen || showsOpenConversation || !!boardCard;

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
          align="center"
          wrap
          gap={token.marginXS}
          style={{
            flexShrink: 0,
            padding: `${token.paddingXS}px ${token.paddingSM}px`,
            borderBottom: `1px solid ${token.colorBorderSecondary}`,
          }}
        >
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
          {/* Labelled actions on their own row, so a narrow pane keeps the title readable. */}
          {hasActions && (
            <Flex wrap gap={token.marginXS} style={{ flexBasis: '100%' }}>
              {onToggleFullScreen && (
                <Button
                  size="small"
                  icon={fullScreen ? <FullscreenExitOutlined /> : <FullscreenOutlined />}
                  onClick={onToggleFullScreen}
                >
                  {fullScreen ? 'Exit full screen' : 'Open full screen'}
                </Button>
              )}
              {sourceSessionId && sourceSessionId !== shownSessionId && (
                <Button
                  size="small"
                  icon={<MessageOutlined />}
                  onClick={() => onOpenConversation(sourceSessionId)}
                >
                  Open conversation
                </Button>
              )}
              {boardCard && (
                <Button
                  size="small"
                  icon={<AimOutlined />}
                  onClick={() => onShowOnBoard(boardCard.id, boardCard.kind)}
                >
                  Show on board
                </Button>
              )}
            </Flex>
          )}
        </Flex>
        <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
          <BoardPreviewBody client={client} target={target} />
        </div>
      </section>
    );
  }
);
