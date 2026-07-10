import { describe, expect, it } from 'vitest';
import { getPrimaryTeammateSessionToRestore } from './primaryTeammateRestore';

const base = {
  currentBoardId: 'board-1',
  primaryTeammateBranchId: 'branch-1',
  effectiveSelectedSessionId: null,
  autoOpenedTeammateBoardId: null,
  restoreAllowed: true,
  sessions: [
    { session_id: 'older', archived: false, last_updated: '2026-01-01T00:00:00.000Z' },
    { session_id: 'newer', archived: false, last_updated: '2026-01-02T00:00:00.000Z' },
  ],
};

describe('getPrimaryTeammateSessionToRestore', () => {
  it('restores the latest active primary-teammate session for generic board/app URLs', () => {
    expect(getPrimaryTeammateSessionToRestore(base)).toBe('newer');
  });

  it('does not restore when route policy disallows generic restore', () => {
    expect(
      getPrimaryTeammateSessionToRestore({
        ...base,
        restoreAllowed: false,
      })
    ).toBeNull();
  });

  it('does not restore when a session is already selected', () => {
    expect(
      getPrimaryTeammateSessionToRestore({
        ...base,
        effectiveSelectedSessionId: 'requested-session',
      })
    ).toBeNull();
  });

  it('does not restore the same board more than once', () => {
    expect(
      getPrimaryTeammateSessionToRestore({
        ...base,
        autoOpenedTeammateBoardId: 'board-1',
      })
    ).toBeNull();
  });

  it('ignores archived sessions', () => {
    expect(
      getPrimaryTeammateSessionToRestore({
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
