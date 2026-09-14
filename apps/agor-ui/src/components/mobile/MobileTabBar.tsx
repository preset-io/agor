import {
  AppstoreOutlined,
  CommentOutlined,
  MenuOutlined,
  MessageOutlined,
  RobotOutlined,
} from '@ant-design/icons';
import { Badge, Button, Typography, theme } from 'antd';

export type MobileTab = 'board' | 'sessions' | 'ask' | 'comments' | 'more';

export interface MobileTabBarProps {
  activeTab: MobileTab | null;
  onSelect: (tab: MobileTab) => void;
  /** Emoji for the primary assistant shown on the center Ask action. */
  askEmoji?: string;
  /** Count of sessions awaiting the user / running (0 hides the badge). */
  sessionsBadge?: number;
  /** Count of unresolved comments (0 hides the badge). */
  commentsBadge?: number;
}

interface TabDef {
  key: Exclude<MobileTab, 'ask'>;
  label: string;
  icon: React.ReactNode;
  badge?: number;
}

const TOUCH_TARGET = 44;

/**
 * Persistent bottom tab bar (thumb zone): Board · Sessions · [Ask primary
 * assistant] · Comments · More. The center Ask is a real elevated primary
 * Button, not a floating FAB. Safe-area aware; the active tab is marked by
 * color AND weight (never color alone).
 */
export const MobileTabBar: React.FC<MobileTabBarProps> = ({
  activeTab,
  onSelect,
  askEmoji,
  sessionsBadge,
  commentsBadge,
}) => {
  const { token } = theme.useToken();
  const askActive = activeTab === 'ask';
  // Size + lift derived from tokens (not a literal). ~half the circle clears the bar.
  const askSize = token.controlHeightLG + token.padding;

  const leftTabs: TabDef[] = [
    { key: 'board', label: 'Board', icon: <AppstoreOutlined /> },
    { key: 'sessions', label: 'Sessions', icon: <MessageOutlined />, badge: sessionsBadge },
  ];
  const rightTabs: TabDef[] = [
    { key: 'comments', label: 'Comments', icon: <CommentOutlined />, badge: commentsBadge },
    { key: 'more', label: 'More', icon: <MenuOutlined /> },
  ];

  const renderTab = (tab: TabDef) => {
    const active = activeTab === tab.key;
    return (
      <button
        key={tab.key}
        type="button"
        aria-label={tab.label}
        aria-current={active ? 'page' : undefined}
        onClick={() => onSelect(tab.key)}
        style={{
          flex: 1,
          minWidth: 0,
          minHeight: TOUCH_TARGET,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: token.sizeXXS,
          padding: token.sizeXXS,
          border: 'none',
          background: 'transparent',
          cursor: 'pointer',
          color: active ? token.colorPrimary : token.colorTextSecondary,
        }}
      >
        <Badge count={tab.badge ?? 0} size="small" offset={[6, -2]}>
          <span style={{ fontSize: token.fontSizeHeading5, color: 'inherit', lineHeight: 1 }}>
            {tab.icon}
          </span>
        </Badge>
        <Typography.Text
          style={{ fontSize: token.fontSizeSM, color: 'inherit', fontWeight: active ? 600 : 400 }}
        >
          {tab.label}
        </Typography.Text>
      </button>
    );
  };

  return (
    <nav
      aria-label="Primary"
      style={{
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        borderTop: `${token.lineWidth}px solid ${token.colorBorderSecondary}`,
        background: token.colorBgContainer,
        paddingBottom: 'env(safe-area-inset-bottom)',
      }}
    >
      {leftTabs.map(renderTab)}

      <div
        style={{
          flex: 1,
          minWidth: 0,
          minHeight: TOUCH_TARGET,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: token.sizeXXS,
        }}
      >
        <Button
          type="primary"
          shape="circle"
          aria-label="Ask your primary assistant"
          aria-current={askActive ? 'page' : undefined}
          onClick={() => onSelect('ask')}
          style={{
            width: askSize,
            height: askSize,
            // Lift so ~half the circle clears the bar.
            marginTop: -askSize / 2,
            // Ring separates the FAB from the bar (reads even in dark, where the
            // shadow token is near-invisible), plus the elevation shadow token.
            boxShadow: `0 0 0 ${token.lineWidthBold * 2}px ${token.colorBgContainer}, ${token.boxShadow}`,
            fontSize: token.fontSizeHeading3,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {askEmoji ? (
            <span style={{ lineHeight: 1 }}>{askEmoji}</span>
          ) : (
            <RobotOutlined style={{ color: token.colorTextLightSolid }} />
          )}
        </Button>
        <Typography.Text
          style={{
            fontSize: token.fontSizeSM,
            lineHeight: 1,
            color: askActive ? token.colorPrimary : token.colorTextSecondary,
            fontWeight: askActive ? 600 : 400,
          }}
        >
          Ask
        </Typography.Text>
      </div>

      {rightTabs.map(renderTab)}
    </nav>
  );
};
