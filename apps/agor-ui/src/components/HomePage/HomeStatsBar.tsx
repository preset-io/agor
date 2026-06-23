import type { Branch, Session } from '@agor-live/client';
import { BranchesOutlined, ClockCircleOutlined, ThunderboltOutlined } from '@ant-design/icons';
import { Typography, theme } from 'antd';
import type React from 'react';
import { useEffect, useMemo, useState } from 'react';

const { Text } = Typography;

const StatItem: React.FC<{
  icon: React.ReactNode;
  value: number;
  label: string;
  iconBg: string;
  iconColor: string;
}> = ({ icon, value, label, iconBg, iconColor }) => {
  const { token } = theme.useToken();
  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '12px 16px',
        background: token.colorBgContainer,
        border: `1px solid ${token.colorBorderSecondary}`,
        borderRadius: token.borderRadiusLG,
        minWidth: 0,
      }}
    >
      <div
        style={{
          width: 38,
          height: 38,
          borderRadius: token.borderRadiusSM,
          background: iconBg,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: iconColor,
          fontSize: 17,
          flexShrink: 0,
        }}
      >
        {icon}
      </div>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 22, fontWeight: 700, lineHeight: 1.1, color: token.colorText }}>
          {value}
        </div>
        <Text type="secondary" style={{ fontSize: 12 }}>
          {label}
        </Text>
      </div>
    </div>
  );
};

export const HomeStatsBar: React.FC<{
  sessionById: Map<string, Session>;
  branchById: Map<string, Branch>;
}> = ({ sessionById, branchById }) => {
  const { token } = theme.useToken();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  const { activeCount, weekCount, branchCount } = useMemo(() => {
    const weekAgo = now - 7 * 24 * 60 * 60 * 1000;
    let activeCount = 0;
    let weekCount = 0;
    for (const s of sessionById.values()) {
      if (s.archived) continue;
      if (
        s.status === 'running' ||
        s.status === 'awaiting_permission' ||
        s.status === 'awaiting_input'
      ) {
        activeCount++;
      }
      if (new Date(s.last_updated).getTime() > weekAgo) {
        weekCount++;
      }
    }
    let branchCount = 0;
    for (const b of branchById.values()) {
      if (!b.archived) branchCount++;
    }
    return { activeCount, weekCount, branchCount };
  }, [sessionById, branchById, now]);

  return (
    <div style={{ display: 'flex', gap: 12, marginBottom: 24 }}>
      <StatItem
        icon={<ThunderboltOutlined />}
        value={activeCount}
        label="Active sessions"
        iconBg={token.colorWarningBg}
        iconColor={token.colorWarning}
      />
      <StatItem
        icon={<ClockCircleOutlined />}
        value={weekCount}
        label="Sessions this week"
        iconBg={token.colorPrimaryBg}
        iconColor={token.colorPrimary}
      />
      <StatItem
        icon={<BranchesOutlined />}
        value={branchCount}
        label="Live branches"
        iconBg={token.colorSuccessBg}
        iconColor={token.colorSuccess}
      />
    </div>
  );
};
