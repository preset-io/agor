import { CloseOutlined, DownOutlined } from '@ant-design/icons';
import { Badge, Button, type ButtonProps, Drawer, Flex, Tooltip, Typography, theme } from 'antd';
import type React from 'react';
import { useState } from 'react';
import { reducedMotionSurface, usePrefersReducedMotion } from '../../hooks/usePrefersReducedMotion';
import { useSessionTabSessions } from '../../hooks/useSessionTabs';
import { MOBILE_TOUCH_TARGET } from '../../utils/deviceDetection';
import { ToolIcon } from '../ToolIcon';
import {
  filterNeedsYou,
  formatNeedsYou,
  getSessionTabStatus,
  getSessionTabTitle,
  SESSION_TAB_STATUS_LABELS,
  SessionTabStatusIcon,
} from './sessionTabStatus';

interface OpenSessionsButtonProps extends Omit<ButtonProps, 'children'> {
  ids: string[];
  /** The session on screen, if any; the others badge the button when they need you. */
  shownId?: string;
  tooltip: string;
}

/** Neutral "{n} open" button with an amber count of the off-screen sessions that need you. */
export const OpenSessionsButton: React.FC<OpenSessionsButtonProps> = ({
  ids,
  shownId,
  tooltip,
  ...buttonProps
}) => {
  const { token } = theme.useToken();
  const sessions = useSessionTabSessions(ids);
  const waiting = filterNeedsYou(sessions.filter((session) => session.session_id !== shownId));
  return (
    <Tooltip
      title={
        <>
          <div>{tooltip}</div>
          {waiting.length > 0 && <div>{formatNeedsYou(waiting)}</div>}
        </>
      }
    >
      <Badge count={waiting.length} color={token.colorWarning} size="small">
        <Button aria-label={`${tooltip}, ${ids.length} open`} {...buttonProps}>
          {ids.length} open
        </Button>
      </Badge>
    </Tooltip>
  );
};

interface OpenSessionsSwitcherProps {
  ids: string[];
  selectedId: string;
  onSelect: (sessionId: string) => void;
  onClose: (sessionId: string) => void;
}

/** Mobile: "{n} open" in the session header opens a sheet listing every open session. */
export const OpenSessionsSwitcher: React.FC<OpenSessionsSwitcherProps> = ({
  ids,
  selectedId,
  onSelect,
  onClose,
}) => {
  const { token } = theme.useToken();
  const sessions = useSessionTabSessions(ids);
  const reducedMotion = usePrefersReducedMotion();
  const [open, setOpen] = useState(false);
  return (
    <>
      <OpenSessionsButton
        ids={ids}
        shownId={selectedId}
        tooltip="Open sessions"
        type="text"
        size="small"
        icon={<DownOutlined />}
        iconPlacement="end"
        onClick={() => setOpen(true)}
        style={{ minHeight: MOBILE_TOUCH_TARGET }}
      />
      <Drawer
        open={open}
        onClose={() => setOpen(false)}
        placement="bottom"
        size="auto"
        title="Open sessions"
        {...reducedMotionSurface(reducedMotion)}
        styles={{
          // Same bounds as MobileMoreSheet: a long list scrolls in the body.
          wrapper: { maxHeight: '85dvh' },
          section: { maxHeight: '85dvh' },
          body: {
            minHeight: 0,
            overflowY: 'auto',
            overscrollBehaviorY: 'contain',
            touchAction: 'pan-y',
            padding: token.paddingXS,
            paddingBottom: `max(${token.paddingXS}px, env(safe-area-inset-bottom))`,
          },
        }}
      >
        {sessions.map((session) => {
          const selected = session.session_id === selectedId;
          const status = getSessionTabStatus(session, selected);
          const title = getSessionTabTitle(session);
          return (
            <Flex key={session.session_id} align="center" gap={token.marginXXS}>
              <Button
                type="text"
                block
                aria-current={selected || undefined}
                onClick={() => {
                  setOpen(false);
                  onSelect(session.session_id);
                }}
                style={{
                  height: 'auto',
                  minHeight: MOBILE_TOUCH_TARGET,
                  minWidth: 0,
                  justifyContent: 'flex-start',
                  textAlign: 'left',
                  background: selected ? token.colorFillSecondary : undefined,
                }}
              >
                <ToolIcon tool={session.agentic_tool} size={24} />
                <Flex vertical style={{ minWidth: 0 }}>
                  <Typography.Text ellipsis>{title}</Typography.Text>
                  <Flex align="center" gap={token.marginXXS}>
                    <SessionTabStatusIcon status={status} />
                    <Typography.Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
                      {SESSION_TAB_STATUS_LABELS[status]}
                    </Typography.Text>
                  </Flex>
                </Flex>
              </Button>
              <Button
                type="text"
                icon={<CloseOutlined />}
                aria-label={`Close tab: ${title}`}
                onClick={() => onClose(session.session_id)}
                style={{ minWidth: MOBILE_TOUCH_TARGET, minHeight: MOBILE_TOUCH_TARGET }}
              />
            </Flex>
          );
        })}
      </Drawer>
    </>
  );
};
