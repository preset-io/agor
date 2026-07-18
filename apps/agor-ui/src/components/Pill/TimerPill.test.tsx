import { TaskStatus } from '@agor-live/client';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TimerPill } from './TimerPill';

vi.mock('antd', () => ({
  Popover: ({ children, content }: { children: ReactNode; content: ReactNode }) => (
    <>
      {children}
      {content}
    </>
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

  it('shows pulse recency, kind, and detail when available', () => {
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
    expect(screen.getByText('progress · agent_message')).toBeInTheDocument();
  });

  it('shows the pulse kind without inventing missing detail', () => {
    render(
      <TimerPill
        status={TaskStatus.RUNNING}
        startedAt="2026-07-18T22:47:23.000Z"
        latestExecutorPulse={{
          sequence: 1,
          kind: 'sdk_started',
          observed_at: '2026-07-18T22:47:24.000Z',
        }}
      />
    );

    expect(screen.getByText('sdk_started')).toBeInTheDocument();
    expect(screen.queryByText(/·/)).not.toBeInTheDocument();
  });

  it('keeps the popover unchanged when no pulse was observed', () => {
    render(<TimerPill status={TaskStatus.RUNNING} startedAt="2026-07-18T22:47:23.000Z" />);

    expect(screen.queryByText('Pulse')).not.toBeInTheDocument();
  });
});
