import { type Session, SessionStatus } from '@agor-live/client';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { getSessionStatusPresentation, SessionStatusIcon } from './SessionStatusIcon';

const SESSIONS: Pick<Session, 'status' | 'ready_for_prompt'>[] = [
  ...Object.values(SessionStatus).map((status) => ({ status })),
  { status: SessionStatus.IDLE, ready_for_prompt: true },
];

describe('session status icons', () => {
  it('never shares an icon and colour between two states', () => {
    const pairs = SESSIONS.map((session) => {
      const { Icon, tone } = getSessionStatusPresentation(session);
      return `${Icon.displayName ?? Icon.name}:${tone}`;
    });
    expect(new Set(pairs).size).toBe(pairs.length);
  });

  it.each([
    [{ status: SessionStatus.RUNNING }, 'Running'],
    [{ status: SessionStatus.STOPPING }, 'Stopping'],
    [{ status: SessionStatus.IDLE }, 'Idle'],
    [{ status: SessionStatus.IDLE, ready_for_prompt: true }, 'Ready'],
    [{ status: SessionStatus.AWAITING_PERMISSION }, 'Waiting for approval'],
  ])('names the icon %o "%s"', (session, label) => {
    render(<SessionStatusIcon session={session} />);
    expect(screen.getByRole('img', { name: label })).toBeInTheDocument();
  });
});
