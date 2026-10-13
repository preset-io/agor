import { type Session, SessionStatus } from '@agor-live/client';
import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { getSessionRowStateLabel, SessionStatusMark } from './sessionRowPresentation';

const session = (overrides: Partial<Session>) =>
  ({ status: SessionStatus.IDLE, ...overrides }) as Session;

it.each([
  [{ status: SessionStatus.RUNNING }, 'Running', 'Running'],
  [{ status: SessionStatus.STOPPING }, 'Stopping', 'Stopping the agent…'],
  [
    { status: SessionStatus.AWAITING_PERMISSION },
    'Waiting for approval',
    'The agent is waiting for your approval.',
  ],
  [{ status: SessionStatus.FAILED }, 'Last run failed', 'The last run ended with an error.'],
  [
    { status: SessionStatus.FAILED, scheduler_init_failure_code: 'creator_unavailable' },
    "Scheduled run didn't start",
    "This scheduled run didn't start.",
  ],
  [{ ready_for_prompt: true }, 'Ready', 'Ready for your next message.'],
] as const)('marks %o as "%s"', (overrides, label, title) => {
  render(<SessionStatusMark session={session(overrides)} />);
  expect(screen.getByRole('img', { name: label })).toHaveAttribute('title', title);
  expect(getSessionRowStateLabel(session(overrides))).toBe(label.toLowerCase());
});

it('has no mark for a plain idle session', () => {
  expect(getSessionRowStateLabel(session({}))).toBeNull();
});
