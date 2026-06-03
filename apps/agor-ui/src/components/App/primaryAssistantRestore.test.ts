import { describe, expect, it } from 'vitest';
import { getPrimaryAssistantSessionToRestore } from './primaryAssistantRestore';

const base = {
  currentBoardId: 'board-1',
  primaryAssistantBranchId: 'branch-1',
  effectiveSelectedSessionId: null,
  autoOpenedAssistantBoardId: null,
  restoreAllowed: true,
  sessions: [
    { session_id: 'older', archived: false, last_updated: '2026-01-01T00:00:00.000Z' },
    { session_id: 'newer', archived: false, last_updated: '2026-01-02T00:00:00.000Z' },
  ],
};

describe('getPrimaryAssistantSessionToRestore', () => {
  it('restores the latest active primary-assistant session for generic board/app URLs', () => {
    expect(getPrimaryAssistantSessionToRestore(base)).toBe('newer');
  });

  it('does not restore when route policy disallows generic restore', () => {
    expect(
      getPrimaryAssistantSessionToRestore({
        ...base,
        restoreAllowed: false,
      })
    ).toBeNull();
  });

  it('does not restore when a session is already selected', () => {
    expect(
      getPrimaryAssistantSessionToRestore({
        ...base,
        effectiveSelectedSessionId: 'requested-session',
      })
    ).toBeNull();
  });

  it('does not restore the same board more than once', () => {
    expect(
      getPrimaryAssistantSessionToRestore({
        ...base,
        autoOpenedAssistantBoardId: 'board-1',
      })
    ).toBeNull();
  });

  it('ignores archived sessions', () => {
    expect(
      getPrimaryAssistantSessionToRestore({
        ...base,
        sessions: [
          {
            session_id: 'archived-newer',
            archived: true,
            last_updated: '2026-01-03T00:00:00.000Z',
          },
          {
            session_id: 'active-older',
            archived: false,
            last_updated: '2026-01-01T00:00:00.000Z',
          },
        ],
      })
    ).toBe('active-older');
  });
});
