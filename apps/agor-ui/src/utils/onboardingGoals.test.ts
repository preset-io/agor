import { describe, expect, it } from 'vitest';
import {
  buildCompletedOnboardingPreferences,
  buildGoalBootstrapGuidance,
  findOnboardingGoal,
  mergeGoalIntegrationRecs,
  ONBOARDING_GOALS,
  ONBOARDING_INTEGRATION_RECOMMENDATIONS,
} from './onboardingGoals';

describe('buildCompletedOnboardingPreferences', () => {
  it('preserves fresh unrelated preferences and authoritatively persists an explicit skip', () => {
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
        { boardId: 'board-1', branchId: '', path: 'teammate', goals: [] }
      )
    ).toEqual({
      use_slack_avatar: false,
      mainBoardId: 'board-1',
      onboarding: {
        goals: [],
        repoId: 'repo-1',
        boardId: 'board-1',
        branchId: '',
        path: 'teammate',
      },
    });
    expect(
      buildCompletedOnboardingPreferences(
        { onboarding: { deferredAt: '2026-08-28T22:00:00.000Z' } },
        { boardId: 'board-1', branchId: '', path: 'teammate', goals: [] }
      ).onboarding
    ).not.toHaveProperty('deferredAt');
  });

  it('persists resumable teammate identity and clears it on an authoritative skip', () => {
    const withTeammate = buildCompletedOnboardingPreferences(undefined, {
      boardId: 'board-1',
      branchId: 'branch-1',
      path: 'teammate',
      goals: ['ship-without-busywork'],
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
      goals: [],
    });
    expect(skipped.onboarding).not.toHaveProperty('teammateDisplayName');
    expect(skipped.onboarding).not.toHaveProperty('teammateEmoji');
    expect(skipped.onboarding).not.toHaveProperty('teammateTemplateId');
  });
});

const names = (goalIds: string[]) => mergeGoalIntegrationRecs(goalIds).map((rec) => rec.name);

describe('ONBOARDING_GOALS', () => {
  it('defines exactly the six goal cards with unique ids and non-empty recs + bootstrap lines', () => {
    expect(ONBOARDING_GOALS).toHaveLength(6);
    const ids = ONBOARDING_GOALS.map((g) => g.id);
    expect(new Set(ids).size).toBe(6);
    for (const goal of ONBOARDING_GOALS) {
      expect(goal.title.length).toBeGreaterThan(0);
      expect(goal.integrationRecs.length).toBeGreaterThan(0);
      expect(goal.bootstrapLine.length).toBeGreaterThan(0);
    }
  });

  it('resolves known ids and returns undefined otherwise', () => {
    expect(findOnboardingGoal('ship-without-busywork')?.title).toBe('Ship without the busywork');
    expect(findOnboardingGoal('nope')).toBeUndefined();
    expect(findOnboardingGoal(null)).toBeUndefined();
  });
});

// Connect items (non-`ask`) are the ones counted against the cap of four.
const connectNames = (goalIds: string[]) =>
  mergeGoalIntegrationRecs(goalIds)
    .filter((rec) => rec.connectMode !== 'ask')
    .map((rec) => rec.name);
const askNames = (goalIds: string[]) =>
  mergeGoalIntegrationRecs(goalIds)
    .filter((rec) => rec.connectMode === 'ask')
    .map((rec) => rec.name);

describe('mergeGoalIntegrationRecs', () => {
  it('falls back to the default set when no goal is picked (Connect items first, then Ask extras)', () => {
    expect(names([])).toEqual(['Linear', 'Notion', 'Firecrawl', 'Slack', 'GitHub']);
  });

  it('ignores unknown goal ids', () => {
    expect(names(['not-a-goal'])).toEqual(['Linear', 'Notion', 'Firecrawl', 'Slack', 'GitHub']);
  });

  it('shows a single goal Connect kit, then its Ask extra', () => {
    // hand-off-build: Connect [GitLab, Supabase, Figma, Context7] + Ask [GitHub].
    expect(names(['hand-off-build'])).toEqual([
      'GitLab',
      'Supabase',
      'Figma',
      'Context7',
      'GitHub',
    ]);
    // status-updates: Connect [Linear, Notion, Atlassian, Asana] + Ask [Slack].
    expect(names(['status-updates'])).toEqual(['Linear', 'Notion', 'Atlassian', 'Asana', 'Slack']);
  });

  it('merges two goals: first two Connect items of primary, then first two of secondary', () => {
    // primary ship [Sentry, GitLab, Linear, Semgrep] + Ask GitHub;
    // secondary dig [Exa, Firecrawl, Tavily, Amplitude], no Ask.
    expect(names(['ship-without-busywork', 'dig-into-anything'])).toEqual([
      'Sentry',
      'GitLab',
      'Exa',
      'Firecrawl',
      'GitHub',
    ]);
  });

  it('dedups Connect items across goals then refills from primary remaining before secondary', () => {
    // primary team [Notion, Linear, Atlassian, Miro] + Ask Slack;
    // secondary personal [Notion, Linear, Firecrawl] + Ask Slack.
    // 2+2: Notion, Linear, (both dupes) → refill primary remaining: Atlassian, Miro.
    // Ask extras deduped to a single Slack.
    expect(names(['team-teammate', 'personal-teammate'])).toEqual([
      'Notion',
      'Linear',
      'Atlassian',
      'Miro',
      'Slack',
    ]);
  });

  it('respects selection order (primary vs secondary is swap-sensitive)', () => {
    expect(names(['dig-into-anything', 'ship-without-busywork'])).toEqual([
      'Exa',
      'Firecrawl',
      'Sentry',
      'GitLab',
      'GitHub',
    ]);
  });

  it('caps Connect items at four; Ask extras are separate and never counted in the four', () => {
    // Both goals are Connect-rich, so the Connect kit fills exactly four.
    expect(connectNames(['status-updates', 'team-teammate'])).toEqual([
      'Linear',
      'Notion',
      'Atlassian',
      'Asana',
    ]);
    // Slack (Ask) still flows through as an extra beyond the four.
    expect(askNames(['status-updates', 'team-teammate'])).toEqual(['Slack']);
  });

  it('discriminates connectMode: oauth / none / ask', () => {
    expect(ONBOARDING_INTEGRATION_RECOMMENDATIONS.linear.connectMode).toBe('oauth');
    expect(ONBOARDING_INTEGRATION_RECOMMENDATIONS.firecrawl.connectMode).toBe('none');
    expect(ONBOARDING_INTEGRATION_RECOMMENDATIONS.context7.connectMode).toBe('none');
    expect(ONBOARDING_INTEGRATION_RECOMMENDATIONS.exa.connectMode).toBe('none');
    expect(ONBOARDING_INTEGRATION_RECOMMENDATIONS.slack.connectMode).toBe('ask');
    expect(ONBOARDING_INTEGRATION_RECOMMENDATIONS.github.connectMode).toBe('ask');
  });

  it('flags only the first rec as featured', () => {
    const recs = mergeGoalIntegrationRecs(['ship-without-busywork']);
    expect(recs[0].featured).toBe(true);
    expect(recs.slice(1).every((rec) => !rec.featured)).toBe(true);
  });

  it('routes recommendations only to their real current Agor surface', () => {
    expect(ONBOARDING_INTEGRATION_RECOMMENDATIONS.slack.setup).toEqual({
      surface: 'mcp-settings',
      endpoint: 'https://mcp.slack.com/mcp',
    });
    expect(ONBOARDING_INTEGRATION_RECOMMENDATIONS.github.setup).toEqual({
      surface: 'connected-repository',
    });
    expect(ONBOARDING_INTEGRATION_RECOMMENDATIONS.linear.setup).toEqual({
      surface: 'marketplace',
      catalogEntryName: 'app.linear/linear',
    });
    expect(Object.values(ONBOARDING_INTEGRATION_RECOMMENDATIONS)).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'HubSpot' }),
        expect.objectContaining({ name: 'Shortcut / Jira' }),
        expect.objectContaining({ name: 'Calendar' }),
      ])
    );
  });
});

describe('buildGoalBootstrapGuidance', () => {
  it('tells the teammate to follow the user when no goal is picked', () => {
    const lines = buildGoalBootstrapGuidance([]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/follow their lead/i);
    expect(lines[0]).toMatch(/do not assume a goal/i);
  });

  it('returns the single goal bootstrap line unchanged', () => {
    expect(buildGoalBootstrapGuidance(['ship-without-busywork'])).toEqual([
      findOnboardingGoal('ship-without-busywork')?.bootstrapLine,
    ]);
  });

  it('concatenates both lines and bridges primary → secondary without a clarifying question', () => {
    const lines = buildGoalBootstrapGuidance(['hand-off-build', 'dig-into-anything']);
    expect(lines[0]).toBe(findOnboardingGoal('hand-off-build')?.bootstrapLine);
    expect(lines[1]).toBe(findOnboardingGoal('dig-into-anything')?.bootstrapLine);
    // Bridging line names primary and secondary without adding another opening command.
    expect(lines[2]).toContain('"Build me an app"');
    expect(lines[2]).toContain('"Dig into anything"');
    expect(lines[2]).toMatch(/do not ask which matters more/i);
  });
});
