import { type AgorClient, isTeammate, type User } from '@agor-live/client';
import {
  AimOutlined,
  BranchesOutlined,
  CloseOutlined,
  FullscreenExitOutlined,
  FullscreenOutlined,
} from '@ant-design/icons';
import { Button, Flex, Tooltip, Typography, theme } from 'antd';
import { forwardRef, useMemo } from 'react';
import type { BoardPreviewTarget } from '../../hooks/useBoardPreview';
import { useAgorStore } from '../../store/agorStore';
import { makeBranchSelector } from '../../store/selectors';
import { teammateLabel } from '../../utils/teammateLabels';
import { BranchDetailsPreview, branchPreviewStatus } from './BranchDetailsPreview';

interface BoardPreviewPaneProps {
  target: BoardPreviewTarget;
  client: AgorClient | null;
  user: User | null | undefined;
  /** The conversation on screen, marked as current in the item's conversations. */
  currentSessionId?: string | null;
  fullScreen: boolean;
  /** Absent when the window is too narrow for a split: the preview stays full screen. */
  onToggleFullScreen?: () => void;
  onShowOnBoard: (branchId: string) => void;
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
    const branch = useAgorStore(
      useMemo(() => makeBranchSelector(target.kind === 'branch' ? target.id : undefined), [target])
    );

    // The header and body for each kind of item. `boardItemId` is the card
    // Show on board pans to; `body` is null once the item is gone.
    const { icon, title, meta, boardItemId, body } = (() => {
      switch (target.kind) {
        case 'branch':
          return {
            icon: <BranchesOutlined />,
            title: branch ? (isTeammate(branch) ? teammateLabel(branch) : branch.name) : 'Branch',
            meta: ['Branch', branch && branchPreviewStatus(branch)].filter(Boolean).join(' · '),
            boardItemId: branch?.branch_id,
            body: branch && (
              <BranchDetailsPreview
                branch={branch}
                client={client}
                user={user}
                currentSessionId={currentSessionId}
              />
            ),
          };
      }
    })();

    const hasActions = !!onToggleFullScreen || !!boardItemId;

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
            <span aria-hidden style={{ color: token.colorTextSecondary }}>
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
              {boardItemId && (
                <Button
                  size="small"
                  icon={<AimOutlined />}
                  onClick={() => onShowOnBoard(boardItemId)}
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
