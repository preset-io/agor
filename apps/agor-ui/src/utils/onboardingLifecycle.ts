import type { Branch, OnboardingState, UserPreferences } from '@agor-live/client';
import { isTeammate } from '@agor-live/client';

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

const ownsTeammateCache = new WeakMap<ReadonlyMap<string, Branch>, Map<string, boolean>>();

/**
 * Whether `userId` owns a live teammate (primary owner, else creator). Cached
 * per branch-map snapshot: the app shell evaluates it on every store update.
 */
export function ownsAnyTeammate(
  branchById: ReadonlyMap<string, Branch>,
  userId: string | undefined
): boolean {
  if (!userId) return false;
  let byUser = ownsTeammateCache.get(branchById);
  if (!byUser) {
    byUser = new Map();
    ownsTeammateCache.set(branchById, byUser);
  }
  let owns = byUser.get(userId);
  if (owns === undefined) {
    owns = false;
    for (const branch of branchById.values()) {
      if (
        !branch.archived &&
        isTeammate(branch) &&
        (branch.primary_owner_user_id ?? branch.created_by) === userId
      ) {
        owns = true;
        break;
      }
    }
    byUser.set(userId, owns);
  }
  return owns;
}
