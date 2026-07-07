import { RiseOutlined, TeamOutlined, ThunderboltOutlined } from '@ant-design/icons';
import { Tooltip, Typography, theme } from 'antd';
import type React from 'react';
import { useEffect, useState } from 'react';
import { agorStore, shallow, useAgorStore, useStoreWithEqualityFn } from '../../store/agorStore';
import { getTimeMs } from '../../utils/entityTime';
import { glassCardStyle } from './homeStyles';

const { Text } = Typography;

const StatCard: React.FC<{
  icon: React.ReactNode;
  value: number | string;
  valueTooltip?: string;
  label: string;
  iconBg: string;
  iconColor: string;
}> = ({ icon, value, valueTooltip, label, iconBg, iconColor }) => {
  const { token } = theme.useToken();

  return (
    <div
      style={{
        flex: 1,
        position: 'relative',
        padding: '14px 16px',
        ...glassCardStyle(token, 0.3),
        border: `1px solid ${token.colorBorderSecondary}`,
        borderRadius: token.borderRadiusLG,
        minWidth: 0,
        overflow: 'hidden',
      }}
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
      <Text type="secondary" style={{ fontSize: 12, display: 'block' }}>
        {label}
      </Text>
    </div>
  );
};

export const HomeStatsBar: React.FC<{
  currentUserId?: string;
}> = ({ currentUserId }) => {
  const { token } = theme.useToken();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  const teamSize = useAgorStore((s) => s.userById.size);

  // Derived counts with shallow equality: session patches that don't change
  // any count (e.g. streaming updates to an already-active session) leave the
  // stats bar un-rendered.
  const { activeTeammates, myThisWeek, runningNow, activeThisWeek } = useStoreWithEqualityFn(
    agorStore,
    (state) => {
      const weekAgo = now - 7 * 24 * 60 * 60 * 1000;

      const activeUserIds = new Set<string>();
      let myThisWeek = 0;
      let runningNow = 0;
      let activeThisWeek = 0;

      for (const s of state.sessionById.values()) {
        if (s.archived) continue;

        const lastUpdated = getTimeMs(s, 'last_updated');
        const updatedAt = Number.isNaN(lastUpdated) ? getTimeMs(s, 'created_at') : lastUpdated;

        if (s.status === 'running') {
          runningNow++;
        }

        if (!Number.isNaN(updatedAt) && updatedAt > weekAgo) {
          activeThisWeek++;
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
        activeThisWeek,
      };
    },
    shallow
  );

  const isMultiUser = teamSize > 1;
  const weekValue =
    isMultiUser && currentUserId && activeThisWeek > 0
      ? `${myThisWeek}/${activeThisWeek}`
      : activeThisWeek;
  const weekTooltip =
    isMultiUser && currentUserId && activeThisWeek > 0
      ? `${myThisWeek} by you, ${activeThisWeek} by the team`
      : undefined;

  return (
    <div style={{ display: 'flex', gap: 12, marginBottom: 24 }}>
      <StatCard
        icon={<TeamOutlined />}
        value={activeTeammates}
        label="Teammates active this week"
        iconBg={token.colorWarningBg}
        iconColor={token.colorWarning}
      />
      <StatCard
        icon={<ThunderboltOutlined />}
        value={runningNow}
        label="Sessions running now"
        iconBg={token.colorPrimaryBg}
        iconColor={token.colorPrimary}
      />
      <StatCard
        icon={<RiseOutlined />}
        value={weekValue}
        valueTooltip={weekTooltip}
        label="Sessions active this week"
        iconBg={token.colorSuccessBg}
        iconColor={token.colorSuccess}
      />
    </div>
  );
};
