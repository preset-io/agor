import { CommentOutlined, RobotOutlined, UnorderedListOutlined } from '@ant-design/icons';
import { Badge, theme } from 'antd';
import type React from 'react';
import { memo } from 'react';
import type { BoardTeammatePanelTab } from './BoardTeammatePanel';

interface RailItem {
  key: BoardTeammatePanelTab;
  label: string;
  icon: React.ReactNode;
}

const RAIL_ITEMS: RailItem[] = [
  { key: 'teammate', label: 'Teammate', icon: <RobotOutlined /> },
  { key: 'all-sessions', label: 'Sessions', icon: <UnorderedListOutlined /> },
  { key: 'comments', label: 'Comments', icon: <CommentOutlined /> },
];

export interface TeammatePanelRailProps {
  onSelectTab: (tab: BoardTeammatePanelTab) => void;
  unreadCommentsCount?: number;
  hasUserMentions?: boolean;
}

// Collapsed-state replacement for the old floating reopen knob (issue #123):
// a persistent, always-fully-visible icon rail rather than a half-clipped,
// low-contrast circle floating at the panel edge.
const TeammatePanelRailComponent: React.FC<TeammatePanelRailProps> = ({
  onSelectTab,
  unreadCommentsCount = 0,
  hasUserMentions = false,
}) => {
  const { token } = theme.useToken();

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
        borderRight: `1px solid ${token.colorBorderSecondary}`,
      }}
    >
      {RAIL_ITEMS.map((item) => {
        const button = (
          <button
            key={item.key}
            type="button"
            aria-label={item.label}
            onClick={() => onSelectTab(item.key)}
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 2,
              width: 48,
              padding: '8px 2px',
              border: 0,
              borderRadius: token.borderRadius,
              background: 'transparent',
              color: token.colorText,
              cursor: 'pointer',
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLButtonElement).style.background = token.colorFillTertiary;
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLButtonElement).style.background = 'transparent';
            }}
          >
            <span style={{ fontSize: 18, lineHeight: 1 }}>{item.icon}</span>
            <span style={{ fontSize: 10, lineHeight: 1.2 }}>{item.label}</span>
          </button>
        );

        if (item.key !== 'comments') return button;

        return (
          <Badge
            key={item.key}
            count={unreadCommentsCount}
            offset={[-10, 10]}
            style={{
              backgroundColor: hasUserMentions ? token.colorError : token.colorPrimaryBgHover,
            }}
          >
            {button}
          </Badge>
        );
      })}
    </div>
  );
};

export const TeammatePanelRail = memo(TeammatePanelRailComponent);

export default TeammatePanelRail;
