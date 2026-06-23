import type { Session } from '@agor-live/client';
import {
  ArrowRightOutlined,
  PlusOutlined,
  RiseOutlined,
  TeamOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import { Tooltip, Typography, theme } from 'antd';
import type React from 'react';
import { useEffect, useMemo, useState } from 'react';

const { Text } = Typography;

const StatCard: React.FC<{
  icon: React.ReactNode;
  value: number | string;
  valueTooltip?: string;
  label: string;
  iconBg: string;
  iconColor: string;
  cta: string;
  ctaIcon?: React.ReactNode;
  onCta: () => void;
}> = ({ icon, value, valueTooltip, label, iconBg, iconColor, cta, ctaIcon, onCta }) => {
  const { token } = theme.useToken();
  const [hovered, setHovered] = useState(false);

  return (
    <div
      style={{
        flex: 1,
        position: 'relative',
        padding: '14px 16px',
        background: token.colorBgContainer,
        border: `1px solid ${token.colorBorderSecondary}`,
        borderRadius: token.borderRadiusLG,
        minWidth: 0,
        overflow: 'hidden',
        transition: 'box-shadow 0.15s',
        boxShadow: hovered ? token.boxShadowTertiary : undefined,
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* Icon — top-right corner keeps number + label consistently anchored left */}
      <div
        style={{
          position: 'absolute',
          top: 12,
          right: 12,
          width: 30,
          height: 30,
          borderRadius: token.borderRadiusSM,
          background: iconBg,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: iconColor,
          fontSize: 14,
        }}
      >
        {icon}
      </div>

      {/* Number */}
      <Tooltip title={valueTooltip}>
        <div
          style={{
            fontSize: 28,
            fontWeight: 700,
            lineHeight: 1,
            color: token.colorText,
            marginBottom: 4,
            paddingRight: 46,
            cursor: valueTooltip ? 'default' : undefined,
          }}
        >
          {value}
        </div>
      </Tooltip>

      {/* Label */}
      <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 10 }}>
        {label}
      </Text>

      {/* CTA */}
      <button
        type="button"
        onClick={onCta}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
          padding: 0,
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          color: token.colorPrimary,
          fontSize: 12,
          fontFamily: 'inherit',
          fontWeight: 500,
        }}
      >
        {ctaIcon ?? <PlusOutlined style={{ fontSize: 10 }} />}
        {cta}
      </button>
    </div>
  );
};

export const HomeStatsBar: React.FC<{
  sessionById: Map<string, Session>;
  currentUserId?: string;
  onSessionClick: (sessionId: string) => void;
  onOpenCreateDialog?: (tab: 'assistant' | 'branch' | 'board' | 'repository') => void;
  onOpenSettings?: (tab: string) => void;
}> = ({ sessionById, currentUserId, onSessionClick, onOpenCreateDialog, onOpenSettings }) => {
  const { token } = theme.useToken();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  const { activeTeammates, myThisWeek, runningNow, latestRunningId, startedThisWeek } =
    useMemo(() => {
      const weekAgo = now - 7 * 24 * 60 * 60 * 1000;

      const activeUserIds = new Set<string>();
      let myThisWeek = 0;
      let runningNow = 0;
      let latestRunningId: string | undefined;
      let latestRunningTime = 0;
      let startedThisWeek = 0;

      for (const s of sessionById.values()) {
        if (s.archived) continue;

        const createdAt = new Date(s.created_at).getTime();
        const updatedAt = new Date(s.last_updated).getTime();

        if (s.status === 'running') {
          runningNow++;
          if (updatedAt > latestRunningTime) {
            latestRunningTime = updatedAt;
            latestRunningId = s.session_id;
          }
        }

        if (createdAt > weekAgo) {
          startedThisWeek++;
          if (s.created_by) activeUserIds.add(s.created_by);
          if (s.created_by === currentUserId) {
            myThisWeek++;
          }
        }
      }

      return {
        activeTeammates: activeUserIds.size,
        myThisWeek,
        runningNow,
        latestRunningId,
        startedThisWeek,
      };
    }, [sessionById, currentUserId, now]);

  const newSession = () => onOpenCreateDialog?.('assistant');

  const weekValue =
    currentUserId && startedThisWeek > 0 ? `${myThisWeek}/${startedThisWeek}` : startedThisWeek;
  const weekTooltip =
    currentUserId && startedThisWeek > 0
      ? `${myThisWeek} started by you, ${startedThisWeek} by the team`
      : undefined;

  return (
    <div style={{ display: 'flex', gap: 12, marginBottom: 24 }}>
      <StatCard
        icon={<TeamOutlined />}
        value={activeTeammates}
        label="Active teammates this week"
        iconBg={token.colorWarningBg}
        iconColor={token.colorWarning}
        cta="Invite a teammate"
        onCta={() => onOpenSettings?.('users')}
      />
      <StatCard
        icon={<ThunderboltOutlined />}
        value={runningNow}
        label="Running right now"
        iconBg={token.colorPrimaryBg}
        iconColor={token.colorPrimary}
        cta={runningNow > 0 && latestRunningId ? 'Open latest session' : 'New assistant'}
        ctaIcon={
          runningNow > 0 && latestRunningId ? (
            <ArrowRightOutlined style={{ fontSize: 10 }} />
          ) : undefined
        }
        onCta={
          runningNow > 0 && latestRunningId ? () => onSessionClick(latestRunningId) : newSession
        }
      />
      <StatCard
        icon={<RiseOutlined />}
        value={weekValue}
        valueTooltip={weekTooltip}
        label="Started this week"
        iconBg={token.colorSuccessBg}
        iconColor={token.colorSuccess}
        cta="New assistant"
        onCta={newSession}
      />
    </div>
  );
};
