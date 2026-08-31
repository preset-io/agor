import { describe, expect, it } from 'vitest';
import {
  buildDeferredOnboardingPreferences,
  buildRestartedOnboardingPreferences,
  buildResumedOnboardingPreferences,
  isOnboardingDeferred,
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
