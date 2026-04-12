import type {
  SessionStatus as SessionStatusValue,
  TaskStatus as TaskStatusValue,
} from '@agor-live/client';
import { SessionStatus, TaskStatus } from '@agor-live/client';
import {
  CheckCircleOutlined,
  ClockCircleOutlined,
  CloseCircleOutlined,
  HourglassOutlined,
  PauseCircleOutlined,
  QuestionCircleOutlined,
  StopOutlined,
} from '@ant-design/icons';
import { Popover, theme } from 'antd';
import type React from 'react';
import { useEffect, useMemo, useState } from 'react';
import { formatAbsoluteTime } from '../../utils/time';
import { Tag } from '../Tag';
import { PILL_COLORS } from './Pill';

type TimerStatus = TaskStatusValue | SessionStatusValue | 'pending';

interface TimerPillProps {
  status: TimerStatus;
  startedAt?: string | number | Date;
  endedAt?: string | number | Date;
  durationMs?: number | null;
  style?: React.CSSProperties;
}

const ACTIVE_STATUSES: TimerStatus[] = [
  TaskStatus.RUNNING,
  TaskStatus.STOPPING,
  TaskStatus.AWAITING_PERMISSION,
  TaskStatus.AWAITING_INPUT,
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
  [TaskStatus.AWAITING_INPUT]: {
    icon: <QuestionCircleOutlined />,
    color: PILL_COLORS.processing,
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
  [TaskStatus.TIMED_OUT]: {
    icon: <ClockCircleOutlined />,
    color: PILL_COLORS.warning,
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

  const isActive = ACTIVE_STATUSES.includes(status);

  const popoverContent = useMemo(() => {
    const labelStyle: React.CSSProperties = {
      color: token.colorTextSecondary,
      minWidth: 60,
    };
    const valueStyle: React.CSSProperties = {
      fontFamily: token.fontFamilyCode,
      color: token.colorText,
    };
    const rowStyle: React.CSSProperties = {
      display: 'flex',
      gap: 8,
      alignItems: 'baseline',
    };

    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
        {startMs && (
          <div style={rowStyle}>
            <span style={labelStyle}>Started</span>
            <span style={valueStyle}>{formatAbsoluteTime(new Date(startMs))}</span>
          </div>
        )}
        <div style={rowStyle}>
          <span style={labelStyle}>Ended</span>
          <span style={valueStyle}>
            {isActive ? 'In progress...' : endMs ? formatAbsoluteTime(new Date(endMs)) : '\u2014'}
          </span>
        </div>
        <div style={rowStyle}>
          <span style={labelStyle}>Duration</span>
          <span style={valueStyle}>{formatDuration(elapsedMs)}</span>
        </div>
      </div>
    );
  }, [startMs, endMs, isActive, elapsedMs, token]);

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

  return (
    <Popover content={popoverContent} placement="bottom">
      {tag}
    </Popover>
  );
};
