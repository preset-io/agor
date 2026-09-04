import type { Session, SessionID } from '@agor-live/client';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { SessionArchiveOutcome } from '../../hooks/useSessionActions';
import {
  formatSessionArchiveOutcome,
  isArchivePermissionDenial,
  SessionArchiveConfirmContent,
} from './SessionArchiveConfirm';

function outcome(overrides: Partial<SessionArchiveOutcome> = {}): SessionArchiveOutcome {
  return {
    session: { session_id: 'root' as SessionID } as Session,
    dryRun: true,
    wouldChangeCount: 3,
    archivedCount: 3,
    unarchivedCount: 0,
    localCount: 1,
    remoteCount: 2,
    skippedCount: 0,
    runningCount: 0,
    units: [
      {
        rootSessionId: 'root' as SessionID,
        kind: 'local',
        status: 'changed',
        changedCount: 1,
        branchId: 'wt-a',
      },
      {
        rootSessionId: 'remote-1' as SessionID,
        kind: 'remote',
        status: 'changed',
        changedCount: 2,
        branchId: 'wt-b',
      },
    ],
    remainingArchived: [],
    ...overrides,
  };
}

describe('SessionArchiveConfirmContent', () => {
  it('shows the previewed local and remote counts with the remote choice checked by default', () => {
    const onChange = vi.fn();
    render(
      <SessionArchiveConfirmContent preview={outcome()} onIncludeRemoteChildrenChange={onChange} />
    );

    expect(screen.getByText(/archives 1 session in this branch/i)).toBeTruthy();
    const checkbox = screen.getByRole('checkbox') as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
    expect(screen.getByText(/2 sessions this one created in 1 other branch/i)).toBeTruthy();
  });

  it('surfaces running work, skipped remote units, and bound overflow', () => {
    render(
      <SessionArchiveConfirmContent
        preview={outcome({
          runningCount: 2,
          skippedCount: 1,
          limitExceeded: 'remote_branch_units',
        })}
        onIncludeRemoteChildrenChange={vi.fn()}
      />
    );

    expect(screen.getByText(/2 sessions still running/i)).toBeTruthy();
    expect(screen.getByText(/1 remote session in branches you cannot modify/i)).toBeTruthy();
    expect(screen.getByText(/too many sessions in other branches/i)).toBeTruthy();
  });
});

describe('formatSessionArchiveOutcome', () => {
  it('reports local and remote counts and a permission warning', () => {
    const { success, warning } = formatSessionArchiveOutcome(
      outcome({ dryRun: false, skippedCount: 1 })
    );
    expect(success).toBe('Archived 3 sessions (1 in this branch, 2 in other branches)');
    expect(warning).toMatch(/1 remote session skipped/);
  });

  it('reports children that stayed archived after a restore', () => {
    const { success, warning } = formatSessionArchiveOutcome(
      outcome({
        dryRun: false,
        archivedCount: 0,
        unarchivedCount: 1,
        localCount: 1,
        remoteCount: 0,
        remainingArchived: [{ sessionId: 'child' as SessionID, reason: 'independent_reason' }],
      }),
      'Restored'
    );
    expect(success).toBe('Restored 1 session');
    expect(warning).toMatch(/1 child session stayed archived/);
  });
});

describe('isArchivePermissionDenial', () => {
  it('recognizes the branch prompt-permission refusal and nothing else', () => {
    expect(
      isArchivePermissionDenial(
        new Error("You need 'prompt' permission to archive sessions in this branch.")
      )
    ).toBe(true);
    expect(isArchivePermissionDenial(new Error('Session not found'))).toBe(false);
  });
});
