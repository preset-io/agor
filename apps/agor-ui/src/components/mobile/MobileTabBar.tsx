import {
  AppstoreOutlined,
  EditOutlined,
  HomeOutlined,
  MenuOutlined,
  ShopOutlined,
} from '@ant-design/icons';
import { Badge, Button, Flex, theme } from 'antd';
import { useId } from 'react';
import { VISUALLY_HIDDEN_STYLE } from '../../utils/accessibility';
import { MOBILE_TOUCH_TARGET as TOUCH_TARGET } from '../../utils/deviceDetection';
import { glassSurfaceStyle } from '../GlassSurface/glassStyles';

export type MobileTab = 'home' | 'board' | 'ask' | 'marketplace' | 'more';

export interface MobileTabBarProps {
  activeTab: MobileTab | null;
  onSelect: (tab: MobileTab) => void;
  /** Count of the viewer's sessions waiting for approval (0 hides the badge). */
  sessionsBadge?: number;
  /** Ask is creating a session; the action shows it and refuses a repeated tap. */
  askPending?: boolean;
}

interface TabDef {
  key: Exclude<MobileTab, 'ask'>;
  label: string;
  icon: React.ReactNode;
  badge?: number;
  /** Spoken description of the badge count. */
  badgeLabel?: string;
}

export function approvalsBadgeLabel(count: number): string {
  return count === 1 ? '1 session needs your approval' : `${count} sessions need your approval`;
}

/**
 * Floating bottom tab bar (thumb zone): Home . Board . [Ask primary assistant]
 * . Marketplace . More. Icon-only: the active destination is marked by a rounded
 * highlight behind its icon plus colorPrimary (not text), so no label can wrap.
 * Ask is the flat solid-teal center action. Safe-area aware; every tab keeps an
 * aria-label and the active one aria-current so names are still announced.
 */
export const MobileTabBar: React.FC<MobileTabBarProps> = ({
  activeTab,
  onSelect,
  sessionsBadge,
  askPending,
}) => {
  const { token } = theme.useToken();
  const badgeDescriptionId = useId();

  const leftTabs: TabDef[] = [
    {
      key: 'home',
      label: 'Home',
      icon: <HomeOutlined />,
      badge: sessionsBadge,
      badgeLabel: sessionsBadge ? approvalsBadgeLabel(sessionsBadge) : undefined,
    },
    { key: 'board', label: 'Board', icon: <AppstoreOutlined /> },
  ];
  const rightTabs: TabDef[] = [
    { key: 'marketplace', label: 'Marketplace', icon: <ShopOutlined /> },
    { key: 'more', label: 'More', icon: <MenuOutlined /> },
  ];

  const renderTab = (tab: TabDef) => {
    const active = activeTab === tab.key;
    const descriptionId = tab.badgeLabel ? `${badgeDescriptionId}-${tab.key}` : undefined;
    return (
      <button
        key={tab.key}
        type="button"
        aria-label={tab.label}
        aria-current={active ? 'page' : undefined}
        aria-describedby={descriptionId}
        onClick={() => onSelect(tab.key)}
        style={{
          // Icon-only: every slot is an equal-width tap target (>=44px), so no
          // label can wrap or unbalance the row. Screen readers still get the
          // name via aria-label + aria-current.
          flex: 1,
          minWidth: TOUCH_TARGET,
          minHeight: TOUCH_TARGET,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 0,
          border: 'none',
          background: 'transparent',
          cursor: 'pointer',
        }}
      >
        {/* Badge rides the icon corner. */}
        {descriptionId && (
          <span id={descriptionId} style={VISUALLY_HIDDEN_STYLE}>
            {tab.badgeLabel}
          </span>
        )}
        <Badge count={tab.badge ?? 0} size="small" offset={[2, -2]} color={token.colorWarning}>
          {/* Fixed rounded-square highlight behind the active icon (icon-sized,
              not label-width) so the active state reads without any text. */}
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: token.controlHeightLG,
              height: token.controlHeightLG,
              borderRadius: token.borderRadius,
              background: active ? token.colorPrimaryBg : 'transparent',
              color: active ? token.colorPrimary : token.colorTextSecondary,
              fontSize: token.fontSizeHeading5,
              lineHeight: 1,
            }}
          >
            {tab.icon}
          </span>
        </Badge>
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
          ...glassSurfaceStyle(token, 0.8),
          borderRadius: token.borderRadiusLG * 2,
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
          {/* Variant B: a flat solid-teal compose button that sits flush in the
              bar (no lift, no shadow). The fill marks it as the primary action. */}
          <Button
            type="primary"
            shape="circle"
            aria-label="Ask your primary assistant"
            onClick={() => onSelect('ask')}
            loading={askPending}
            icon={<EditOutlined style={{ color: token.colorTextLightSolid }} />}
            style={{
              width: TOUCH_TARGET,
              height: TOUCH_TARGET,
              boxShadow: 'none',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          />
        </div>

        {rightTabs.map(renderTab)}
      </Flex>
    </nav>
  );
};
