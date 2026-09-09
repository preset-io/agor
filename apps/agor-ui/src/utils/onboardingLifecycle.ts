import type { OnboardingState, UserPreferences } from '@agor-live/client';

export type OnboardingReopenMode = 'resume' | 'restart';

export function isOnboardingDeferred(preferences: UserPreferences | undefined): boolean {
  const deferredAt = preferences?.onboarding?.deferredAt;
  return typeof deferredAt === 'string' && deferredAt.trim().length > 0;
}

/** Merge a deferral marker into the latest server snapshot without completing onboarding. */
export function buildDeferredOnboardingPreferences(
  latest: UserPreferences | undefined,
  deferredAt: string,
  progress: Partial<OnboardingState> = {}
): UserPreferences {
  return {
    ...latest,
    onboarding: {
      ...(latest?.onboarding ?? {}),
      ...progress,
      deferredAt,
    },
  };
}

/** Remove only the deferral marker so durable onboarding progress can resume. */
export function buildResumedOnboardingPreferences(
  latest: UserPreferences | undefined
): UserPreferences {
  const onboarding = { ...(latest?.onboarding ?? {}) };
  delete onboarding.deferredAt;
  return {
    ...latest,
    onboarding,
  };
}

/** Clear wizard progress only for an explicit restart-from-beginning action. */
export function buildRestartedOnboardingPreferences(
  latest: UserPreferences | undefined
): UserPreferences {
  const preferences = { ...(latest ?? {}) };
  delete preferences.onboarding;
  return preferences;
}
