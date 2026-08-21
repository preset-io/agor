import { describe, expect, it } from 'vitest';
import { findOnboardingGoal, ONBOARDING_INTEGRATION_RECOMMENDATIONS } from './onboardingGoals';
import {
  buildTeammateBootstrapPrompt,
  buildTeammateBootstrapPromptContext,
  buildTeammateFirstSessionTitle,
} from './teammateBootstrapPrompt';

describe('buildTeammateBootstrapPrompt', () => {
  it('names the first session in plain language (CP-23: no "bootstrap"/"onboarding" jargon)', () => {
    const withEmoji = buildTeammateFirstSessionTitle({ displayName: 'Rusty', emoji: '🤖' });
    expect(withEmoji).toBe('🤖 Rusty — first session');
    expect(withEmoji).not.toMatch(/bootstrap|onboarding/i);
    expect(buildTeammateFirstSessionTitle({ displayName: 'Rusty' })).toBe('Rusty — first session');
  });

  it('formats teammate identity params without browser-side Handlebars rendering', () => {
    const prompt = buildTeammateBootstrapPrompt({
      displayName: 'PR Reviewer',
      emoji: '🧐',
      description: 'Reviews pull requests',
      userName: 'Max',
      userEmail: 'max@example.com',
    });

    expect(prompt).toContain('### First-session onboarding instructions for Agor AI teammate');
    expect(prompt).toContain('- AI teammate: PR Reviewer 🧐');
    expect(prompt).toContain('- AI teammate description: Reviews pull requests');
    expect(prompt).toContain('- User: Max <max@example.com>');
    expect(prompt).toContain('Read ONBOARDING.md if it exists; otherwise, read BOOTSTRAP.md');
    // No goal supplied → neutral opener, not the primary-goal one.
    expect(prompt).toContain('Ask exactly one specific question');
    expect(prompt).not.toContain('take the primary goal above');
    expect(prompt).not.toMatch(/\{\{\s*#?\/?\s*(assistant|user)\b/);
    // No goals supplied → no goal-guidance block.
    expect(prompt).not.toContain('What the user wants:');
  });

  it('normalizes fallback identity values in the prompt context', () => {
    const context = buildTeammateBootstrapPromptContext({ displayName: '  ', emoji: null });

    expect(context).toEqual({
      teammate: {
        displayName: 'My Teammate',
        emoji: '🤖',
      },
      firstSession: true,
    });
  });

  it('omits optional user, description and goal lines when absent', () => {
    const prompt = buildTeammateBootstrapPrompt({ displayName: 'Board Bot', emoji: '🧭' });

    expect(prompt).toContain('- AI teammate: Board Bot 🧭');
    expect(prompt).not.toContain('AI teammate description:');
    expect(prompt).not.toContain('- User:');
    expect(prompt).not.toContain('- User email:');
    expect(prompt).not.toContain('What the user wants:');
    expect(prompt).not.toMatch(/\{\{\s*#?\/?\s*(assistant|user)\b/);
  });

  it('renders capability-aware suggested-integration guidance (CP-11)', () => {
    const prompt = buildTeammateBootstrapPrompt({
      displayName: 'Board Bot',
      suggestedIntegrations: [
        ONBOARDING_INTEGRATION_RECOMMENDATIONS.slack,
        ONBOARDING_INTEGRATION_RECOMMENDATIONS.github,
        ONBOARDING_INTEGRATION_RECOMMENDATIONS.sentry,
      ],
    });
    expect(prompt).toContain('- Suggested tools and connections: Slack, GitHub, Sentry');
    // The integrations are not just listed — the teammate is told to propose them.
    expect(prompt).toMatch(/when one of these would unlock the first win/i);
    expect(prompt).toContain('Sentry: direct the user to Marketplace');
    expect(prompt).toContain(
      'Slack: direct the user to Settings → MCP Servers and use the official endpoint https://mcp.slack.com/mcp'
    );
    expect(prompt).toContain('Do not call this a Marketplace entry');
    expect(prompt).toContain('GitHub: use the repository already connected to Agor');
    expect(prompt).toContain('Do not describe this as an MCP or Marketplace install');

    // Empty / whitespace-only lists drop the line AND the proposal instruction.
    const emptyList = buildTeammateBootstrapPrompt({
      displayName: 'Board Bot',
      suggestedIntegrations: [],
    });
    expect(emptyList).not.toContain('Suggested tools and connections');
    expect(emptyList).not.toMatch(/when a suggested integration would unlock that win/i);

    const whitespaceOnly = buildTeammateBootstrapPrompt({
      displayName: 'Board Bot',
      suggestedIntegrations: [
        {
          ...ONBOARDING_INTEGRATION_RECOMMENDATIONS.linear,
          name: '  ',
        },
      ],
    });
    expect(whitespaceOnly).not.toContain('Suggested tools and connections');

    const absent = buildTeammateBootstrapPrompt({ displayName: 'Board Bot' });
    expect(absent).not.toContain('Suggested tools and connections');
  });

  it('renders goal-driven guidance for a single goal', () => {
    const prompt = buildTeammateBootstrapPrompt({
      displayName: 'Board Bot',
      goals: ['ship-without-busywork'],
    });
    expect(prompt).toContain('What the user wants:');
    expect(prompt).toContain(findOnboardingGoal('ship-without-busywork')?.bootstrapLine ?? '');
  });

  it('concatenates both goal lines and a bridging line for two goals', () => {
    const prompt = buildTeammateBootstrapPrompt({
      displayName: 'Board Bot',
      goals: ['hand-off-build', 'dig-into-anything'],
    });
    expect(prompt).toContain(findOnboardingGoal('hand-off-build')?.bootstrapLine ?? '');
    expect(prompt).toContain(findOnboardingGoal('dig-into-anything')?.bootstrapLine ?? '');
    expect(prompt).toMatch(/do not ask which matters more/i);
  });

  it('renders a follow-the-user guidance line when onboarding was skipped (empty goals)', () => {
    const prompt = buildTeammateBootstrapPrompt({ displayName: 'Board Bot', goals: [] });
    expect(prompt).toContain('What the user wants:');
    expect(prompt).toMatch(/follow their lead/i);
  });

  it('uses one executable ask-or-act strategy based on whether a goal resolves', () => {
    // Real goal → act immediately when possible, otherwise ask only one question.
    const withGoal = buildTeammateBootstrapPrompt({
      displayName: 'Board Bot',
      goals: ['ship-without-busywork'],
    });
    expect(withGoal).toMatch(/if live context is sufficient, perform one concrete first-win/i);
    expect(withGoal).toMatch(/if essential context is missing, ask exactly one specific question/i);
    expect(withGoal.match(/Canonical opening strategy:/g)).toHaveLength(1);

    // Skip (empty goals): the opener must NOT claim a primary goal — that would
    // contradict the "follow their lead / do not assume a goal" guidance above.
    const skipped = buildTeammateBootstrapPrompt({ displayName: 'Board Bot', goals: [] });
    expect(skipped).not.toContain('take the primary goal above');
    expect(skipped).toMatch(/do not assume a goal/i);
    expect(skipped).toMatch(/ask exactly one specific question/i);

    // Non-onboarding teammate (no goals block at all): no primary goal exists,
    // so the opener must not reference "the primary goal above".
    const nonOnboarding = buildTeammateBootstrapPrompt({ displayName: 'Board Bot' });
    expect(nonOnboarding).not.toContain('take the primary goal above');
    expect(nonOnboarding).toMatch(/do not assume a goal/i);

    // All-unknown goal ids resolve to nothing → treated like a skip, no primary goal.
    const unknown = buildTeammateBootstrapPrompt({ displayName: 'Board Bot', goals: ['nope'] });
    expect(unknown).not.toContain('take the primary goal above');
    expect(unknown).toMatch(/do not assume a goal/i);
  });
});
