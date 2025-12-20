import type {
  SessionStatus as SessionStatusValue,
  TaskStatus as TaskStatusValue,
} from '@agor/core/types';
import { SessionStatus, TaskStatus } from '@agor/core/types';
import {
  CheckCircleOutlined,
  CloseCircleOutlined,
  HourglassOutlined,
  PauseCircleOutlined,
  StopOutlined,
} from '@ant-design/icons';
import { Tooltip, theme } from 'antd';
import type React from 'react';
import { useEffect, useMemo, useState } from 'react';
import { Tag } from '../Tag';
import { PILL_COLORS } from './Pill';

type TimerStatus = TaskStatusValue | SessionStatusValue | 'pending';

interface TimerPillProps {
  status: TimerStatus;
  startedAt?: string | number | Date;
  endedAt?: string | number | Date;
  durationMs?: number | null;
  tooltip?: string;
  style?: React.CSSProperties;
}

const ACTIVE_STATUSES: TimerStatus[] = [
  TaskStatus.RUNNING,
  TaskStatus.STOPPING,
  TaskStatus.AWAITING_PERMISSION,
];

const statusConfig: Record<
  TimerStatus,
  {
    icon: React.ReactElement;
    color: string;
    label?: string;
  }
> = {
  [TaskStatus.RUNNING]: {
    icon: <HourglassOutlined />,
    color: PILL_COLORS.processing,
  },
  [TaskStatus.STOPPING]: {
    icon: <PauseCircleOutlined />,
    color: PILL_COLORS.warning,
  },
  [TaskStatus.AWAITING_PERMISSION]: {
    icon: <PauseCircleOutlined />,
    color: PILL_COLORS.warning,
  },
  [TaskStatus.COMPLETED]: {
    icon: <CheckCircleOutlined />,
    color: PILL_COLORS.success,
  },
  [TaskStatus.FAILED]: {
    icon: <CloseCircleOutlined />,
    color: PILL_COLORS.error,
  },
  [TaskStatus.STOPPED]: {
    icon: <StopOutlined />,
    color: PILL_COLORS.warning,
  },
  [SessionStatus.IDLE]: {
    icon: <HourglassOutlined />,
    color: PILL_COLORS.session,
  },
  [TaskStatus.CREATED]: {
    icon: <HourglassOutlined />,
    color: PILL_COLORS.session,
    label: '00:00',
  },
  pending: {
    icon: <HourglassOutlined />,
    color: PILL_COLORS.session,
  },
} as const;

function parseTimestamp(value?: string | number | Date): number | null {
  if (!value) {
    return null;
  }

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.getTime();
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }

  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function formatDuration(milliseconds: number): string {
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) {
    return '00:00';
  }

  const totalSeconds = Math.floor(milliseconds / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const hh = hours.toString().padStart(2, '0');
  const mm = minutes.toString().padStart(2, '0');
  const ss = seconds.toString().padStart(2, '0');

  return hours > 0 ? `${hh}:${mm}:${ss}` : `${mm}:${ss}`;
}

export const TimerPill: React.FC<TimerPillProps> = ({
  status,
  startedAt,
  endedAt,
  durationMs,
  tooltip,
  style,
}) => {
  const { token } = theme.useToken();
  const startMs = useMemo(() => parseTimestamp(startedAt), [startedAt]);
  const endMs = useMemo(() => parseTimestamp(endedAt), [endedAt]);

  const fixedDuration = useMemo(() => {
    if (typeof durationMs === 'number' && durationMs >= 0) {
      return durationMs;
    }

    if (startMs && endMs && endMs >= startMs) {
      return endMs - startMs;
    }

    return null;
  }, [durationMs, startMs, endMs]);

  const [elapsedMs, setElapsedMs] = useState(() => {
    if (fixedDuration !== null) {
      return fixedDuration;
    }

    if (startMs) {
      return Math.max(0, Date.now() - startMs);
    }

    return 0;
  });

  useEffect(() => {
    if (fixedDuration !== null) {
      setElapsedMs(fixedDuration);
      return;
    }

    if (!startMs) {
      setElapsedMs(0);
      return;
    }

    setElapsedMs(Math.max(0, Date.now() - startMs));
  }, [fixedDuration, startMs]);

  useEffect(() => {
    if (!startMs) {
      return;
    }

    if (!ACTIVE_STATUSES.includes(status)) {
      return;
    }

    const interval = window.setInterval(() => {
      setElapsedMs(Math.max(0, Date.now() - startMs));
    }, 1000);

    return () => window.clearInterval(interval);
  }, [startMs, status]);

  if (!startMs && fixedDuration === null) {
    return null;
  }

  const config = statusConfig[status] || statusConfig.pending;
  const label = config.label ?? formatDuration(elapsedMs);
  const tag = (
    <Tag icon={config.icon} color={config.color} style={style}>
      <span style={{ fontFamily: token.fontFamilyCode, lineHeight: 1 }}>{label}</span>
    </Tag>
  );

  return tooltip ? <Tooltip title={tooltip}>{tag}</Tooltip> : tag;
};
