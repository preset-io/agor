import type { Session } from '@agor-live/client';
import { CloseOutlined, DoubleRightOutlined, DownOutlined } from '@ant-design/icons';
import { Badge, Button, Dropdown, Flex, Tabs, Tooltip, Typography, theme } from 'antd';
import type React from 'react';
import { useRef } from 'react';
import { useElementWidth } from '../../hooks/useElementWidth';
import { useSessionTabSessions } from '../../hooks/useSessionTabs';
import { ToolIcon } from '../ToolIcon';
import {
  filterNeedsYou,
  formatNeedsYou,
  getSessionTabStatus,
  getSessionTabTitle,
  SESSION_TAB_STATUS_LABELS,
  SessionTabStatusIcon,
} from './sessionTabStatus';

/** Tabs share the row between these widths, Chrome style. */
const MIN_TAB_WIDTH = 200;
const MAX_TAB_WIDTH = 280;
/** antd's small card padding and close button around the label. */
const TAB_CHROME_WIDTH = 46;
/** antd's card gutter between tabs. */
const TAB_GAP = 2;
const MORE_BUTTON_WIDTH = 96;
const HIDE_BUTTON_WIDTH = 40;

/**
 * As many tabs as fit at the minimum width in `room`, stretched to share the
 * row up to the maximum. The selected one always stays visible, order is kept.
 */
export function splitVisibleTabs<T extends { session_id: string }>(
  sessions: T[],
  selectedId: string,
  room: number
): { visible: T[]; hidden: T[]; tabWidth: number } {
  const fitsAll = sessions.length * (MIN_TAB_WIDTH + TAB_GAP) <= room;
  const row = fitsAll ? room : room - MORE_BUTTON_WIDTH;
  const fit = fitsAll ? sessions.length : Math.max(1, Math.floor(row / (MIN_TAB_WIDTH + TAB_GAP)));
  const tabWidth = Math.min(
    MAX_TAB_WIDTH,
    Math.max(MIN_TAB_WIDTH, Math.floor(row / fit) - TAB_GAP)
  );
  let visible = sessions.slice(0, fit);
  if (!visible.some((session) => session.session_id === selectedId)) {
    const selected = sessions.find((session) => session.session_id === selectedId);
    if (selected) visible = [...visible.slice(0, fit - 1), selected];
  }
  return {
    visible,
    hidden: sessions.filter((session) => !visible.includes(session)),
    tabWidth,
  };
}

interface SessionTabsProps {
  ids: string[];
  selectedId: string;
  onSelect: (sessionId: string) => void;
  onClose: (sessionId: string) => void;
  onCloseOthers: (sessionId: string) => void;
  /** Adds a Hide panel button at the end of the row. */
  onHide?: () => void;
}

export const SessionTabs: React.FC<SessionTabsProps> = ({
  ids,
  selectedId,
  onSelect,
  onClose,
  onCloseOthers,
  onHide,
}) => {
  const { token } = theme.useToken();
  const barRef = useRef<HTMLDivElement>(null);
  const barWidth = useElementWidth(barRef);
  const sessions = useSessionTabSessions(ids);
  const { visible, hidden, tabWidth } = splitVisibleTabs(
    sessions,
    selectedId,
    barWidth - (onHide ? HIDE_BUTTON_WIDTH : 0)
  );
  const hiddenWaiting = filterNeedsYou(hidden);

  const statusLine = (session: Session) => {
    const status = getSessionTabStatus(session, session.session_id === selectedId);
    return (
      <Flex align="center" gap={token.marginXXS}>
        <SessionTabStatusIcon status={status} />
        <span>{SESSION_TAB_STATUS_LABELS[status]}</span>
      </Flex>
    );
  };

  return (
    <div ref={barRef} style={{ flexShrink: 0, background: token.colorBgContainer }}>
      <Tabs
        type="editable-card"
        hideAdd
        size="small"
        activeKey={selectedId}
        onChange={onSelect}
        onEdit={(key, action) => {
          if (action === 'remove' && typeof key === 'string') onClose(key);
        }}
        locale={{ removeAriaLabel: 'Close tab' }}
        tabBarStyle={{ margin: 0, paddingTop: token.paddingXXS }}
        tabBarExtraContent={{
          right: (
            <Flex align="center" gap={token.marginXXS} style={{ paddingInline: token.paddingXS }}>
              {hidden.length > 0 && (
                <Dropdown
                  trigger={['click']}
                  placement="bottomRight"
                  menu={{
                    onClick: ({ key }) => onSelect(key),
                    items: [
                      {
                        type: 'group',
                        label: 'More tabs',
                        children: hidden.map((session) => ({
                          key: session.session_id,
                          icon: <ToolIcon tool={session.agentic_tool} size={20} />,
                          label: (
                            <Flex vertical style={{ maxWidth: 280 }}>
                              <Typography.Text ellipsis>
                                {getSessionTabTitle(session)}
                              </Typography.Text>
                              <Typography.Text
                                type="secondary"
                                style={{ fontSize: token.fontSizeSM }}
                              >
                                {statusLine(session)}
                              </Typography.Text>
                            </Flex>
                          ),
                        })),
                      },
                    ],
                  }}
                >
                  <Tooltip
                    title={
                      <>
                        <div>More tabs</div>
                        {hiddenWaiting.length > 0 && <div>{formatNeedsYou(hiddenWaiting)}</div>}
                      </>
                    }
                  >
                    <Badge count={hiddenWaiting.length} color={token.colorWarning} size="small">
                      <Button size="small">
                        {hidden.length} more <DownOutlined />
                      </Button>
                    </Badge>
                  </Tooltip>
                </Dropdown>
              )}
              {onHide && (
                <Tooltip title="Hide panel. Your tabs stay open.">
                  <Button
                    type="text"
                    size="small"
                    aria-label="Hide panel"
                    icon={<DoubleRightOutlined />}
                    onClick={onHide}
                  />
                </Tooltip>
              )}
            </Flex>
          ),
        }}
        items={visible.map((session) => {
          const title = getSessionTabTitle(session);
          return {
            key: session.session_id,
            closeIcon: (
              <Tooltip title="Close tab. The agent keeps running.">
                <CloseOutlined />
              </Tooltip>
            ),
            label: (
              <Dropdown
                trigger={['contextMenu']}
                menu={{
                  items: [
                    {
                      key: 'close',
                      label: 'Close tab',
                      onClick: () => onClose(session.session_id),
                    },
                    {
                      key: 'close-others',
                      label: 'Close other tabs',
                      onClick: () => onCloseOthers(session.session_id),
                    },
                  ],
                }}
              >
                <Tooltip
                  title={
                    <>
                      <div>{title}</div>
                      {statusLine(session)}
                    </>
                  }
                >
                  <Flex
                    align="center"
                    gap={token.marginXS}
                    style={{ width: tabWidth - TAB_CHROME_WIDTH }}
                  >
                    <ToolIcon tool={session.agentic_tool} size={16} bordered={false} />
                    <Typography.Text ellipsis style={{ flex: 1, minWidth: 0, color: 'inherit' }}>
                      {title}
                    </Typography.Text>
                    <SessionTabStatusIcon
                      status={getSessionTabStatus(session, session.session_id === selectedId)}
                    />
                  </Flex>
                </Tooltip>
              </Dropdown>
            ),
          };
        })}
      />
    </div>
  );
};
