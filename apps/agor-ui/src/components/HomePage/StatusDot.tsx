import type React from 'react';

const STATUS_COLORS: Record<string, string> = {
  running: '#22c55e',
  awaiting_permission: '#f97316',
  awaiting_input: '#f97316',
  stopping: '#f97316',
  timed_out: '#ef4444',
  failed: '#ef4444',
  idle: '#d1d5db',
  completed: '#d1d5db',
};

const STATUS_LABELS: Record<string, string> = {
  running: 'Running',
  awaiting_permission: 'Awaiting permission',
  awaiting_input: 'Awaiting input',
  stopping: 'Stopping',
  timed_out: 'Timed out',
  failed: 'Failed',
  idle: 'Idle',
  completed: 'Completed',
};

const STATUS_ANIMATION: Record<string, string> = {
  running: 'status-dot-run',
  awaiting_permission: 'status-dot-wait',
  awaiting_input: 'status-dot-wait',
  stopping: 'status-dot-wait',
};

export const StatusDot: React.FC<{ status: string; size?: number }> = ({ status, size = 7 }) => {
  const color = STATUS_COLORS[status] ?? '#d1d5db';
  const cls = STATUS_ANIMATION[status] ?? '';
  const label = STATUS_LABELS[status] ?? status.replaceAll('_', ' ');
  return (
    <span
      role="img"
      aria-label={`Status: ${label}`}
      className={cls}
      style={{
        display: 'inline-block',
        width: size,
        height: size,
        borderRadius: '50%',
        background: color,
        flexShrink: 0,
      }}
    />
  );
};
