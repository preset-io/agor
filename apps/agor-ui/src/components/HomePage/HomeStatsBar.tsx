import type { Session } from '@agor-live/client';
import { CheckCircleOutlined, MessageOutlined, ThunderboltOutlined } from '@ant-design/icons';
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
  zeroLabel?: string;
}> = ({ icon, value, label, iconBg, iconColor, zeroLabel }) => {
  const { token } = theme.useToken();
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
      }}
    >
      {/* Icon — top-right corner so number + label always align consistently */}
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
      <div
        style={{
          fontSize: 28,
          fontWeight: 700,
          lineHeight: 1,
          color: token.colorText,
          marginBottom: 5,
          paddingRight: 46,
        }}
      >
        {value}
      </div>
      {/* Label */}
      <Text type="secondary" style={{ fontSize: 12, lineHeight: 1.3 }}>
        {value === 0 && zeroLabel ? zeroLabel : label}
      </Text>
    </div>
  );
};

export const HomeStatsBar: React.FC<{
  sessionById: Map<string, Session>;
  currentUserId?: string;
}> = ({ sessionById, currentUserId }) => {
  const { token } = theme.useToken();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  const { waitingForYou, runningNow, doneToday } = useMemo(() => {
    const todayStart = new Date(now);
    todayStart.setHours(0, 0, 0, 0);
    const todayMs = todayStart.getTime();

    let waitingForYou = 0;
    let runningNow = 0;
    let doneToday = 0;

    for (const s of sessionById.values()) {
      if (s.archived) continue;
      if (s.status === 'running') runningNow++;
      if (
        (s.status === 'awaiting_permission' || s.status === 'awaiting_input') &&
        (!currentUserId || s.created_by === currentUserId)
      ) {
        waitingForYou++;
      }
      if (
        (s.status === 'completed' || s.status === 'idle') &&
        new Date(s.last_updated).getTime() >= todayMs
      ) {
        doneToday++;
      }
    }

    return { waitingForYou, runningNow, doneToday };
  }, [sessionById, currentUserId, now]);

  return (
    <div style={{ display: 'flex', gap: 12, marginBottom: 24 }}>
      <StatItem
        icon={<MessageOutlined />}
        value={waitingForYou}
        label="Waiting for your reply"
        zeroLabel="All caught up"
        iconBg={waitingForYou > 0 ? token.colorWarningBg : token.colorSuccessBg}
        iconColor={waitingForYou > 0 ? token.colorWarning : token.colorSuccess}
      />
      <StatItem
        icon={<ThunderboltOutlined />}
        value={runningNow}
        label="Running right now"
        zeroLabel="Nothing running"
        iconBg={token.colorPrimaryBg}
        iconColor={token.colorPrimary}
      />
      <StatItem
        icon={<CheckCircleOutlined />}
        value={doneToday}
        label="Sessions done today"
        zeroLabel="Nothing done yet today"
        iconBg={token.colorSuccessBg}
        iconColor={token.colorSuccess}
      />
    </div>
  );
};
