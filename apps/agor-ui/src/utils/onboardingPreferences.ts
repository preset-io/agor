import type { UserPreferences } from '@agor-live/client';

export interface CompletedOnboardingPreferencesInput {
  boardId: string;
  branchId: string;
  path: 'teammate' | 'own-repo';
  teammateName?: string;
  teammateEmoji?: string;
  templateId?: string | null;
}

/** Merge completion into the freshest available preference snapshot. */
export function buildCompletedOnboardingPreferences(
  latest: UserPreferences | undefined,
  result: CompletedOnboardingPreferencesInput
): UserPreferences {
  const retainedOnboarding = { ...(latest?.onboarding ?? {}) };
  delete retainedOnboarding.deferredAt;
  delete retainedOnboarding.teammateDisplayName;
  delete retainedOnboarding.teammateEmoji;
  delete retainedOnboarding.teammateTemplateId;
  return {
    ...latest,
    mainBoardId: result.boardId || latest?.mainBoardId,
    onboarding: {
      ...retainedOnboarding,
      path: result.path,
      branchId: result.branchId,
      boardId: result.boardId,
      ...(result.teammateName ? { teammateDisplayName: result.teammateName } : {}),
      ...(result.teammateName && result.teammateEmoji
        ? { teammateEmoji: result.teammateEmoji }
        : {}),
      ...(result.teammateName && result.templateId
        ? { teammateTemplateId: result.templateId }
        : {}),
    },
  };
}
