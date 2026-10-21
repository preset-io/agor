import { isTeammate } from '@agor-live/client';
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
    { target, fullScreen, onToggleFullScreen, onShowOnBoard, onClose },
    ref
  ) {
    const { token } = theme.useToken();
    const branch = useAgorStore(useMemo(() => makeBranchSelector(target.id), [target.id]));
    const title = branch ? (isTeammate(branch) ? teammateLabel(branch) : branch.name) : 'Branch';
    const meta = ['Branch', branch && branchPreviewStatus(branch)].filter(Boolean).join(' · ');

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
          gap={token.marginXS}
          style={{
            flexShrink: 0,
            padding: `${token.paddingXS}px ${token.paddingSM}px`,
            borderBottom: `1px solid ${token.colorBorderSecondary}`,
          }}
        >
          <BranchesOutlined aria-hidden style={{ color: token.colorTextSecondary }} />
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
          {onToggleFullScreen && (
            <Button
              size="small"
              icon={fullScreen ? <FullscreenExitOutlined /> : <FullscreenOutlined />}
              onClick={onToggleFullScreen}
            >
              {fullScreen ? 'Exit full screen' : 'Open full screen'}
            </Button>
          )}
          {branch && (
            <Button
              size="small"
              icon={<AimOutlined />}
              onClick={() => onShowOnBoard(branch.branch_id)}
            >
              Show on board
            </Button>
          )}
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
        <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
          {branch ? (
            <BranchDetailsPreview branch={branch} />
          ) : (
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
