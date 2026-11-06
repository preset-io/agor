import { describe, expect, it } from 'vitest';
import {
  buildDeferredOnboardingPreferences,
  buildRestartedOnboardingPreferences,
  buildResumedOnboardingPreferences,
  isOnboardingDeferred,
  ownsAnyTeammate,
} from './onboardingLifecycle';

describe('onboarding deferral preferences', () => {
  it('merges into the latest preferences without marking completion or losing progress', () => {
    const preferences = buildDeferredOnboardingPreferences(
      {
        audio: { enabled: true, chime: 'gentle-chime', volume: 0.5, minDurationSeconds: 0 },
        onboarding: { boardId: 'board-1', goals: ['status-updates'] },
      },
      '2026-08-28T22:00:00.000Z',
      { boardId: 'board-candidate', teammateDisplayName: 'Ada' }
    );

    expect(preferences).toMatchObject({
      onboarding: {
        boardId: 'board-candidate',
        goals: ['status-updates'],
        teammateDisplayName: 'Ada',
        deferredAt: '2026-08-28T22:00:00.000Z',
      },
    });
    expect(isOnboardingDeferred(preferences)).toBe(true);
  });

  it('does not treat absent or malformed markers as durable deferral', () => {
    expect(isOnboardingDeferred(undefined)).toBe(false);
    expect(isOnboardingDeferred({ onboarding: {} })).toBe(false);
    expect(isOnboardingDeferred({ onboarding: { deferredAt: undefined } })).toBe(false);
    expect(isOnboardingDeferred({ onboarding: { deferredAt: '  ' } })).toBe(false);
  });

  it('resumes by clearing only deferredAt and preserving resource identity', () => {
    expect(
      buildResumedOnboardingPreferences({
        mainBoardId: 'board-main',
        onboarding: {
          deferredAt: '2026-08-28T22:00:00.000Z',
          boardId: 'board-candidate',
          branchId: 'branch-existing',
          teammateDisplayName: 'Ada',
        },
      })
    ).toEqual({
      mainBoardId: 'board-main',
      onboarding: {
        boardId: 'board-candidate',
        branchId: 'branch-existing',
        teammateDisplayName: 'Ada',
      },
    });
  });

  it('restarts only when explicitly asked by clearing wizard progress', () => {
    expect(
      buildRestartedOnboardingPreferences({
        mainBoardId: 'board-main',
        onboarding: {
          deferredAt: '2026-08-28T22:00:00.000Z',
          boardId: 'board-candidate',
        },
      })
    ).toEqual({ mainBoardId: 'board-main' });
  });
});

describe('ownsAnyTeammate', () => {
  const teammate = (id: string, owner: string, archived = false) =>
    ({
      branch_id: id,
      archived,
      created_by: owner,
      custom_context: { teammate: { kind: 'teammate', displayName: 'Ada' } },
    }) as never;
  it('is true once the user owns a live teammate (e.g. an imported one)', () => {
    const plain = { branch_id: 'b0', archived: false, created_by: 'me' } as never;
    expect(ownsAnyTeammate(new Map([['b0', plain]]), 'me')).toBe(false);
    expect(ownsAnyTeammate(new Map([['b1', teammate('b1', 'someone-else')]]), 'me')).toBe(false);
    expect(ownsAnyTeammate(new Map([['b2', teammate('b2', 'me', true)]]), 'me')).toBe(false);
    expect(ownsAnyTeammate(new Map([['b3', teammate('b3', 'me')]]), 'me')).toBe(true);
  });
});
