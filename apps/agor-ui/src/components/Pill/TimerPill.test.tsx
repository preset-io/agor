import { TaskStatus } from '@agor-live/client';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isRateLimitPulse, TimerPill } from './TimerPill';

vi.mock('antd', () => ({
  Popover: ({ children, content }: { children: ReactNode; content: ReactNode }) => (
    <>
      {children}
      {content}
    </>
  ),
  Tooltip: ({ children, title }: { children: ReactNode; title?: ReactNode }) => (
    <span data-tooltip={typeof title === 'string' ? title : undefined}>{children}</span>
  ),
  theme: {
    useToken: () => ({
      token: {
        colorText: '#fff',
        colorTextSecondary: '#aaa',
        fontFamilyCode: 'monospace',
      },
    }),
  },
}));

vi.mock('../Tag', () => ({
  Tag: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));

describe('TimerPill pulse diagnostics', () => {
  afterEach(() => vi.useRealTimers());

  it('shows a friendly pulse state while preserving raw detail as diagnostics', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-18T22:47:39.000Z'));

    render(
      <TimerPill
        status={TaskStatus.RUNNING}
        startedAt="2026-07-18T22:47:23.000Z"
        latestExecutorPulse={{
          sequence: 3,
          kind: 'progress',
          detail: 'agent_message',
          observed_at: '2026-07-18T22:47:36.000Z',
        }}
      />
    );

    expect(screen.getByText('Pulse')).toBeInTheDocument();
    expect(screen.getByText('00:03 ago')).toBeInTheDocument();
    expect(screen.getByText('Working').parentElement).toHaveAttribute(
      'data-tooltip',
      'Latest SDK event: agent_message'
    );
    expect(screen.queryByText('agent_message')).not.toBeInTheDocument();
  });

  it.each([
    ['sdk_started', 'Starting'],
    ['waiting', 'Waiting'],
    ['unknown_activity', 'Active'],
  ] as const)('presents %s as %s', (kind, label) => {
    render(
      <TimerPill
        status={TaskStatus.RUNNING}
        startedAt="2026-07-18T22:47:23.000Z"
        latestExecutorPulse={{
          sequence: 1,
          kind,
          observed_at: '2026-07-18T22:47:24.000Z',
        }}
      />
    );

    expect(screen.getByText(label)).toBeInTheDocument();
  });

  it('keeps the popover unchanged when no pulse was observed', () => {
    render(<TimerPill status={TaskStatus.RUNNING} startedAt="2026-07-18T22:47:23.000Z" />);

    expect(screen.queryByText('Pulse')).not.toBeInTheDocument();
  });

  // A rate-limited task stays RUNNING and stops producing output, which is
  // indistinguishable from a hang unless the label reads the pulse detail.
  it.each([
    ['rate_limit.five_hour', 'Rate limited'],
    ['rate_limit.seven_day_opus', 'Rate limited'],
    ['permission.request', 'Waiting'],
  ])('distinguishes a waiting pulse detailed %s as %s', (detail, label) => {
    render(
      <TimerPill
        status={TaskStatus.RUNNING}
        startedAt="2026-07-18T22:47:23.000Z"
        latestExecutorPulse={{
          sequence: 1,
          kind: 'waiting',
          detail,
          observed_at: '2026-07-18T22:47:24.000Z',
        }}
      />
    );

    expect(screen.getByText(label)).toBeInTheDocument();
  });

  it('reports a rate-limit block from the pulse alone', () => {
    expect(
      isRateLimitPulse({
        sequence: 1,
        kind: 'waiting',
        detail: 'rate_limit.five_hour',
        observed_at: '2026-07-18T22:47:24.000Z',
      })
    ).toBe(true);
    // Not every wait is a block, and not every rate-limit detail is a wait:
    // the resume signal rides the same prefix on a different kind.
    expect(
      isRateLimitPulse({
        sequence: 2,
        kind: 'waiting',
        detail: 'permission.request',
        observed_at: '2026-07-18T22:47:24.000Z',
      })
    ).toBe(false);
    expect(
      isRateLimitPulse({
        sequence: 3,
        kind: 'sdk_started',
        detail: 'rate_limit.resolved',
        observed_at: '2026-07-18T22:47:24.000Z',
      })
    ).toBe(false);
    expect(isRateLimitPulse(null)).toBe(false);
  });
});
