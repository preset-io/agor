import { describe, expect, it } from 'vitest';
import {
  buildCompletedOnboardingPreferences,
  buildGoalBootstrapGuidance,
  findOnboardingGoal,
  mergeGoalMcpRecs,
  ONBOARDING_GOALS,
} from './onboardingGoals';

describe('buildCompletedOnboardingPreferences', () => {
  it('preserves fresh unrelated preferences and authoritatively persists an explicit skip', () => {
    expect(
      buildCompletedOnboardingPreferences(
        {
          use_slack_avatar: false,
          onboarding: { goals: ['stale-goal'], repoId: 'repo-1' },
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
  });
});

const names = (goalIds: string[]) => mergeGoalMcpRecs(goalIds).map((rec) => rec.name);

describe('ONBOARDING_GOALS', () => {
  it('defines exactly the six goal cards with unique ids and non-empty recs + bootstrap lines', () => {
    expect(ONBOARDING_GOALS).toHaveLength(6);
    const ids = ONBOARDING_GOALS.map((g) => g.id);
    expect(new Set(ids).size).toBe(6);
    for (const goal of ONBOARDING_GOALS) {
      expect(goal.title.length).toBeGreaterThan(0);
      expect(goal.mcpRecs.length).toBeGreaterThan(0);
      expect(goal.bootstrapLine.length).toBeGreaterThan(0);
    }
  });

  it('resolves known ids and returns undefined otherwise', () => {
    expect(findOnboardingGoal('ship-without-busywork')?.title).toBe('Ship without the busywork');
    expect(findOnboardingGoal('nope')).toBeUndefined();
    expect(findOnboardingGoal(null)).toBeUndefined();
  });
});

describe('mergeGoalMcpRecs', () => {
  it('falls back to the default set when no goal is picked', () => {
    expect(names([])).toEqual(['Slack', 'GitHub', 'Linear', 'Notion']);
  });

  it('ignores unknown goal ids', () => {
    expect(names(['not-a-goal'])).toEqual(['Slack', 'GitHub', 'Linear', 'Notion']);
  });

  it('shows a single goal rec list verbatim (no merge, no padding to four)', () => {
    // hand-off-build has only two recs — the list stays two long.
    expect(names(['hand-off-build'])).toEqual(['GitHub', 'Figma']);
    // status-updates already has four.
    expect(names(['status-updates'])).toEqual(['Linear', 'Shortcut / Jira', 'Slack', 'Calendar']);
  });

  it('merges two goals: first two of primary, first two of secondary', () => {
    // primary ship-without-busywork [GitHub, Sentry, Datadog], secondary dig-into-anything [Amplitude, HubSpot]
    expect(names(['ship-without-busywork', 'dig-into-anything'])).toEqual([
      'GitHub',
      'Sentry',
      'Amplitude',
      'HubSpot',
    ]);
  });

  it('dedups across goals then refills from primary remaining before secondary remaining', () => {
    // primary team-teammate [Slack, HubSpot, Linear, Datadog], secondary personal-teammate [Slack]
    // step1+2: Slack, HubSpot, (Slack deduped) → [Slack, HubSpot]
    // refill from primary remaining: Linear, Datadog → [Slack, HubSpot, Linear, Datadog]
    expect(names(['team-teammate', 'personal-teammate'])).toEqual([
      'Slack',
      'HubSpot',
      'Linear',
      'Datadog',
    ]);
  });

  it('respects selection order (primary vs secondary is swap-sensitive)', () => {
    expect(names(['dig-into-anything', 'ship-without-busywork'])).toEqual([
      'Amplitude',
      'HubSpot',
      'GitHub',
      'Sentry',
    ]);
  });

  it('caps the merged list at four even when both goals are rec-rich', () => {
    const merged = names(['status-updates', 'team-teammate']);
    expect(merged).toHaveLength(4);
    // first two of each: Linear, Shortcut/Jira, Slack, HubSpot
    expect(merged).toEqual(['Linear', 'Shortcut / Jira', 'Slack', 'HubSpot']);
  });

  it('flags only the first rec as featured', () => {
    const recs = mergeGoalMcpRecs(['ship-without-busywork']);
    expect(recs[0].featured).toBe(true);
    expect(recs.slice(1).every((rec) => !rec.featured)).toBe(true);
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
    // Bridging line names the primary as the concrete opener and the secondary as the follow-up.
    expect(lines[2]).toContain('"Hand off the build"');
    expect(lines[2]).toContain('"Dig into anything"');
    expect(lines[2]).toMatch(/do not ask which matters more/i);
  });
});
