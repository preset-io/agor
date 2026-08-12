import {
  BranchesOutlined,
  CommentOutlined,
  RobotOutlined,
  UnorderedListOutlined,
} from '@ant-design/icons';
import { Badge, theme } from 'antd';
import type React from 'react';
import { memo, useState } from 'react';
import { useUIMode } from '../../contexts/UIModeContext';
import type { BoardTeammatePanelTab } from './BoardTeammatePanel';

interface RailItem {
  key: BoardTeammatePanelTab;
  label: string;
  icon: React.ReactNode;
}

const RAIL_ITEMS: RailItem[] = [
  { key: 'teammate', label: 'Teammate', icon: <RobotOutlined /> },
  { key: 'all-sessions', label: 'Sessions', icon: <UnorderedListOutlined /> },
  { key: 'all-branches', label: 'Branches', icon: <BranchesOutlined /> },
  { key: 'comments', label: 'Comments', icon: <CommentOutlined /> },
];

export interface TeammatePanelRailProps {
  onSelectTab: (tab: BoardTeammatePanelTab) => void;
  /** Section currently shown in the expanded panel; null when collapsed. */
  activeTab?: BoardTeammatePanelTab | null;
  unreadCommentsCount?: number;
  hasUserMentions?: boolean;
}

// Collapsed-state replacement for the old floating reopen knob (issue #123):
// a persistent, always-fully-visible icon rail rather than a half-clipped,
// low-contrast circle floating at the panel edge.
const TeammatePanelRailComponent: React.FC<TeammatePanelRailProps> = ({
  onSelectTab,
  activeTab = null,
  unreadCommentsCount = 0,
  hasUserMentions = false,
}) => {
  const { token } = theme.useToken();
  const { isSlim } = useUIMode();
  const [hoveredKey, setHoveredKey] = useState<BoardTeammatePanelTab | null>(null);

  return (
    <div
      style={{
        height: '100%',
        width: '100%',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 4,
        paddingTop: 12,
        background: token.colorBgContainer,
        // Border faces the canvas: rail sits on the right edge in slim
        // (border on its left), left edge in classic (border on its right).
        ...(isSlim
          ? { borderLeft: `1px solid ${token.colorBorderSecondary}` }
          : { borderRight: `1px solid ${token.colorBorderSecondary}` }),
      }}
    >
      {RAIL_ITEMS.map((item) => {
        const isActive = item.key === activeTab;
        const isHovered = item.key === hoveredKey;
        // Light-touch states: hover tints only a compact chip behind the
        // icon; active swaps the icon to the accent color and lights a 2px
        // bar on the rail's outer edge. No full-button fill.
        const iconChip = (
          <span
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 32,
              height: 32,
              borderRadius: 8,
              fontSize: 18,
              lineHeight: 1,
              background: isHovered ? token.colorFillTertiary : 'transparent',
              color: isActive ? token.colorPrimary : 'inherit',
              transition: 'background 0.15s',
            }}
          >
            {item.icon}
          </span>
        );

        return (
          <button
            key={item.key}
            type="button"
            aria-label={item.label}
            onClick={() => onSelectTab(item.key)}
            onMouseEnter={() => setHoveredKey(item.key)}
            onMouseLeave={() => setHoveredKey(null)}
            style={{
              position: 'relative',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 3,
              width: '100%',
              padding: '6px 0',
              border: 0,
              background: 'transparent',
              color: token.colorText,
              cursor: 'pointer',
            }}
          >
            {/* Badge wraps only the icon chip so the button itself keeps the
                full rail width — the edge indicator anchors to the rail edge,
                not the badge wrapper's shrink-wrapped box. */}
            {item.key === 'comments' ? (
              <Badge
                count={unreadCommentsCount}
                offset={[-2, 4]}
                style={{
                  backgroundColor: hasUserMentions ? token.colorError : token.colorPrimaryBgHover,
                }}
              >
                {iconChip}
              </Badge>
            ) : (
              iconChip
            )}
            <span
              style={{
                fontSize: 10,
                lineHeight: 1.2,
                color: isActive || isHovered ? token.colorText : token.colorTextSecondary,
              }}
            >
              {item.label}
            </span>
            {isActive && (
              <span
                style={{
                  position: 'absolute',
                  right: 0,
                  top: 6,
                  bottom: 6,
                  width: 2,
                  borderRadius: 1,
                  background: token.colorPrimary,
                }}
              />
            )}
          </button>
        );
      })}
    </div>
  );
};

export const TeammatePanelRail = memo(TeammatePanelRailComponent);

export default TeammatePanelRail;
