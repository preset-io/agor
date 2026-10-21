import type { AgorClient, User } from '@agor-live/client';
import { CloseOutlined, MessageOutlined } from '@ant-design/icons';
import { Button, Drawer, Flex, Typography, theme } from 'antd';
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { BoardViewContext, type BoardViewContextValue } from '../../contexts/BoardViewContext';
import type { BoardPreviewTarget } from '../../hooks/useBoardPreview';
import { reducedMotionSurface, usePrefersReducedMotion } from '../../hooks/usePrefersReducedMotion';
import { useStableCallback } from '../../hooks/useStableCallback';
import { MOBILE_TOUCH_TARGET } from '../../utils/deviceDetection';
import { useBoardPreviewContent } from '../BoardPreview/BoardPreviewPane';

const SheetContent: React.FC<{
  client: AgorClient | null;
  user: User | null | undefined;
  target: BoardPreviewTarget;
  /** The conversation already on screen, which needs no "Open conversation". */
  shownSessionId?: string;
  onOpenConversation: (sessionId: string) => void;
  onClose: () => void;
}> = ({ client, user, target, shownSessionId, onOpenConversation, onClose }) => {
  const { token } = theme.useToken();
  const { icon, title, meta, sourceSessionId, body } = useBoardPreviewContent(target, {
    client,
    user,
    currentSessionId: shownSessionId,
  });
  return (
    <Flex vertical style={{ height: '100%' }}>
      <Flex
        align="center"
        wrap
        gap={token.marginXS}
        style={{ flexShrink: 0, padding: `0 ${token.padding}px ${token.paddingXS}px` }}
      >
        <span aria-hidden style={{ display: 'flex' }}>
          {icon}
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <Typography.Text strong ellipsis style={{ display: 'block' }}>
            {title}
          </Typography.Text>
          <Typography.Text type="secondary" ellipsis style={{ fontSize: token.fontSizeSM }}>
            {meta}
          </Typography.Text>
        </div>
        <Button
          type="text"
          aria-label="Close preview"
          icon={<CloseOutlined />}
          style={{ minWidth: MOBILE_TOUCH_TARGET, minHeight: MOBILE_TOUCH_TARGET }}
          onClick={onClose}
        />
        {sourceSessionId && sourceSessionId !== shownSessionId && (
          <Button
            block
            icon={<MessageOutlined />}
            style={{ minHeight: MOBILE_TOUCH_TARGET }}
            onClick={() => onOpenConversation(sourceSessionId)}
          >
            Open conversation
          </Button>
        )}
      </Flex>
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
        {body || (
          <Typography.Text type="secondary" style={{ display: 'block', padding: token.padding }}>
            No longer available
          </Typography.Text>
        )}
      </div>
    </Flex>
  );
};

/**
 * The board preview on phones: a bottom sheet over the page, opened through the
 * same `BoardViewContext` as desktop, so Files rows and work cards need no
 * phone-specific code. "Open conversation" goes to the session page.
 */
export function MobileBoardPreview({
  client,
  user,
  shownSessionId,
  children,
}: {
  client: AgorClient | null;
  user: User | null | undefined;
  shownSessionId?: string;
  children: React.ReactNode;
}) {
  const { token } = theme.useToken();
  const navigate = useNavigate();
  const reducedMotion = usePrefersReducedMotion();
  const [previewTarget, setPreviewTarget] = useState<BoardPreviewTarget | null>(null);

  const openPreview = useStableCallback((target: BoardPreviewTarget) => setPreviewTarget(target));
  const closePreview = useStableCallback(() => setPreviewTarget(null));
  const openConversation = useStableCallback((sessionId: string) => {
    setPreviewTarget(null);
    navigate(`/m/session/${sessionId}`);
  });
  // Phones have no Board tab beside the conversation; their board canvas is read-only.
  const showOnBoard = useStableCallback(() => {});

  const value = useMemo<BoardViewContextValue>(
    () => ({
      view: null,
      showOnBoard,
      previewTarget,
      openPreview,
      closePreview,
      openConversation,
    }),
    [showOnBoard, previewTarget, openPreview, closePreview, openConversation]
  );
  const tall = previewTarget?.kind === 'artifact';

  return (
    <BoardViewContext.Provider value={value}>
      {children}
      <Drawer
        open={!!previewTarget}
        onClose={closePreview}
        placement="bottom"
        size="auto"
        title={null}
        closable={false}
        {...reducedMotionSurface(reducedMotion)}
        styles={{
          wrapper: { maxHeight: '85dvh' },
          section: { maxHeight: '85dvh' },
          body: {
            ...(tall ? { height: '75dvh' } : {}),
            minHeight: 0,
            overflowY: 'auto',
            overscrollBehaviorY: 'contain',
            padding: `${token.paddingSM}px 0`,
            paddingBottom: `max(${token.paddingSM}px, env(safe-area-inset-bottom))`,
          },
        }}
      >
        {previewTarget && (
          <SheetContent
            client={client}
            user={user}
            target={previewTarget}
            shownSessionId={shownSessionId}
            onOpenConversation={openConversation}
            onClose={closePreview}
          />
        )}
      </Drawer>
    </BoardViewContext.Provider>
  );
}
