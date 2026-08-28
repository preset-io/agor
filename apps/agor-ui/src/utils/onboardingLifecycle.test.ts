import { describe, expect, it } from 'vitest';
import { buildDeferredOnboardingPreferences, isOnboardingDeferred } from './onboardingLifecycle';

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
});
