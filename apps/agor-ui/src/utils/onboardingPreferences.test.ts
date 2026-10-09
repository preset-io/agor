import { describe, expect, it } from 'vitest';
import { buildCompletedOnboardingPreferences } from './onboardingPreferences';

describe('buildCompletedOnboardingPreferences', () => {
  it('preserves fresh unrelated preferences, including legacy goals', () => {
    expect(
      buildCompletedOnboardingPreferences(
        {
          use_slack_avatar: false,
          onboarding: {
            goals: ['stale-goal'],
            repoId: 'repo-1',
            deferredAt: '2026-08-28T22:00:00.000Z',
          },
        },
        { boardId: 'board-1', branchId: '', path: 'teammate' }
      )
    ).toEqual({
      use_slack_avatar: false,
      mainBoardId: 'board-1',
      onboarding: {
        goals: ['stale-goal'],
        repoId: 'repo-1',
        boardId: 'board-1',
        branchId: '',
        path: 'teammate',
      },
    });
    expect(
      buildCompletedOnboardingPreferences(
        { onboarding: { deferredAt: '2026-08-28T22:00:00.000Z' } },
        { boardId: 'board-1', branchId: '', path: 'teammate' }
      ).onboarding
    ).not.toHaveProperty('deferredAt');
  });

  it('persists resumable teammate identity and clears it on an authoritative skip', () => {
    const withTeammate = buildCompletedOnboardingPreferences(undefined, {
      boardId: 'board-1',
      branchId: 'branch-1',
      path: 'teammate',
      teammateName: 'Rusty',
      teammateEmoji: '⚖️',
      templateId: 'legal-analyst',
    });
    expect(withTeammate.onboarding).toMatchObject({
      teammateDisplayName: 'Rusty',
      teammateEmoji: '⚖️',
      teammateTemplateId: 'legal-analyst',
    });

    const skipped = buildCompletedOnboardingPreferences(withTeammate, {
      boardId: 'board-2',
      branchId: '',
      path: 'teammate',
    });
    expect(skipped.onboarding).not.toHaveProperty('teammateDisplayName');
    expect(skipped.onboarding).not.toHaveProperty('teammateEmoji');
    expect(skipped.onboarding).not.toHaveProperty('teammateTemplateId');
  });
});
