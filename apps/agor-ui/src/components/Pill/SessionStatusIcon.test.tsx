import { type Session, SessionStatus } from '@agor-live/client';
import { describe, expect, it } from 'vitest';
import { getSessionStatusPresentation } from './SessionStatusIcon';

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
});
