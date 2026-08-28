import type { OnboardingState, UserPreferences } from '@agor-live/client';

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
