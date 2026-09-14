import {
  AppstoreOutlined,
  CommentOutlined,
  HomeOutlined,
  MenuOutlined,
  RobotOutlined,
} from '@ant-design/icons';
import { Badge, Button, Flex, Typography, theme } from 'antd';

export type MobileTab = 'home' | 'board' | 'ask' | 'comments' | 'more';

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
 * Floating bottom tab bar (thumb zone): Home . Board . [Ask primary assistant]
 * . Comments . More. The active destination expands into an icon+label pill;
 * the others stay icon-only. Ask is the raised center action. Safe-area aware;
 * active state is marked by the pill + colour + aria-current (not colour alone).
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
  const askSize = token.controlHeightLG + token.padding;

  const leftTabs: TabDef[] = [
    { key: 'home', label: 'Home', icon: <HomeOutlined />, badge: sessionsBadge },
    { key: 'board', label: 'Board', icon: <AppstoreOutlined /> },
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
          alignItems: 'center',
          justifyContent: 'center',
          gap: token.marginXXS,
          paddingInline: token.paddingXS,
          border: 'none',
          background: active ? token.colorPrimaryBg : 'transparent',
          borderRadius: token.borderRadiusLG,
          cursor: 'pointer',
          color: active ? token.colorPrimary : token.colorTextSecondary,
        }}
      >
        <Badge count={tab.badge ?? 0} size="small" offset={[6, -2]}>
          <span style={{ fontSize: token.fontSizeHeading5, color: 'inherit', lineHeight: 1 }}>
            {tab.icon}
          </span>
        </Badge>
        {active && (
          <Typography.Text
            style={{ fontSize: token.fontSizeSM, color: 'inherit', fontWeight: 600 }}
          >
            {tab.label}
          </Typography.Text>
        )}
      </button>
    );
  };

  return (
    <nav
      aria-label="Primary"
      style={{
        flexShrink: 0,
        paddingInline: token.padding,
        paddingTop: token.paddingXS,
        paddingBottom: `calc(${token.paddingXS}px + env(safe-area-inset-bottom))`,
      }}
    >
      <Flex
        align="center"
        style={{
          borderRadius: token.borderRadiusLG * 2,
          background: token.colorBgElevated,
          border: `${token.lineWidth}px solid ${token.colorBorderSecondary}`,
          boxShadow: token.boxShadowSecondary,
          paddingInline: token.paddingXS,
          minHeight: TOUCH_TARGET + token.paddingXS * 2,
        }}
      >
        {leftTabs.map(renderTab)}

        <div
          style={{
            flex: 1,
            minWidth: 0,
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
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
              // Ring separates the FAB from the bar (reads even in dark) + shadow.
              boxShadow: `0 0 0 ${token.lineWidthBold * 2}px ${token.colorBgElevated}, ${token.boxShadow}`,
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
        </div>

        {rightTabs.map(renderTab)}
      </Flex>
    </nav>
  );
};
