import { describe, expect, it } from 'vitest';
import { findOnboardingGoal, ONBOARDING_INTEGRATION_RECOMMENDATIONS } from './onboardingGoals';
import {
  buildTeammateBootstrapPrompt,
  buildTeammateBootstrapPromptContext,
  buildTeammateFirstSessionTitle,
} from './teammateBootstrapPrompt';

const LEAD_LINE = 'Your first message sets the working relationship.';
const DOCS_HOOK = 'link the single most relevant one instead of pasting a how-to';

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
    // The personal lead line and docs hook are always emitted.
    expect(prompt).toContain(LEAD_LINE);
    expect(prompt).toContain(DOCS_HOOK);
    // No goal and no template → the single-question fallback opener.
    expect(prompt).toMatch(
      /ask exactly one specific question about what Max is working on right now/i
    );
    // No goals supplied → no goal-guidance block and no template context line.
    expect(prompt).not.toContain('What the user wants:');
    expect(prompt).not.toContain('Created from the');
    expect(prompt).not.toMatch(/\{\{\s*#?\/?\s*(assistant|user)\b/);
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

  it('omits optional user, description, template and goal lines when absent', () => {
    const prompt = buildTeammateBootstrapPrompt({ displayName: 'Board Bot', emoji: '🧭' });

    expect(prompt).toContain('- AI teammate: Board Bot 🧭');
    expect(prompt).not.toContain('AI teammate description:');
    expect(prompt).not.toContain('- User:');
    expect(prompt).not.toContain('- User email:');
    expect(prompt).not.toContain('Created from the');
    expect(prompt).not.toContain('What the user wants:');
    // With no name, the fallback opener addresses "the user".
    expect(prompt).toMatch(/what the user is working on right now/i);
    expect(prompt).not.toMatch(/\{\{\s*#?\/?\s*(assistant|user)\b/);
  });

  it('surfaces the chosen template title in Context and opens personally on template alone', () => {
    const prompt = buildTeammateBootstrapPrompt({
      displayName: 'Counsel',
      userName: 'Max',
      // No goals at all, only a template → the personal opener must still fire.
      templateId: 'legal-analyst',
    });

    expect(prompt).toContain('- Created from the Legal Analyst template.');
    expect(prompt).toMatch(/Open as yourself: one warm line, in your persona's voice/);
    expect(prompt).toContain('set up as a Legal Analyst to help Max');
    expect(prompt).toMatch(/ground the opening in the template's remit/i);
    expect(prompt).not.toContain('see "What the user wants" above');
    expect(prompt).not.toMatch(/specific to that goal/i);
    expect(prompt).toContain('- End with a single clear next step.');
    // Not the single-question fallback.
    expect(prompt).not.toMatch(/ask exactly one specific question about what/i);
  });

  it('treats the blank starter as no template (no persona, fallback opener)', () => {
    const prompt = buildTeammateBootstrapPrompt({
      displayName: 'Board Bot',
      templateId: 'blank',
    });
    expect(prompt).not.toContain('Created from the');
    expect(prompt).toMatch(/ask exactly one specific question about what/i);

    // An unknown template id is likewise ignored.
    const unknown = buildTeammateBootstrapPrompt({
      displayName: 'Board Bot',
      templateId: 'nope',
    });
    expect(unknown).not.toContain('Created from the');
  });

  it('preserves the reviewed setup route for every suggested integration', () => {
    const prompt = buildTeammateBootstrapPrompt({
      displayName: 'Board Bot',
      suggestedIntegrations: [
        ONBOARDING_INTEGRATION_RECOMMENDATIONS.slack,
        ONBOARDING_INTEGRATION_RECOMMENDATIONS.github,
        ONBOARDING_INTEGRATION_RECOMMENDATIONS.sentry,
      ],
    });
    expect(prompt).toContain('- Suggested tools and connections: Slack, GitHub, Sentry');

    expect(prompt).toContain('Slack: first check whether a configured server is already available');
    expect(prompt).toContain('https://mcp.slack.com/mcp');
    expect(prompt).toMatch(/use session scope and attach it to this session/i);
    expect(prompt).toMatch(/workspace member policy/i);
    expect(prompt).not.toMatch(/admin-only MCP settings/i);

    expect(prompt).toContain('GitHub: use the repository already connected to Agor');
    expect(prompt).toContain('Do not describe this as an MCP or Catalog install');

    expect(prompt).toContain('Sentry: use the reviewed Catalog entry io.sentry/mcp');
    expect(prompt).toMatch(/do not bypass the catalog by registering a guessed endpoint/i);
    expect(prompt).toContain(DOCS_HOOK);
  });

  it('drops the MCP line for empty / whitespace-only integration lists, keeps the docs hook', () => {
    const emptyList = buildTeammateBootstrapPrompt({
      displayName: 'Board Bot',
      suggestedIntegrations: [],
    });
    expect(emptyList).not.toContain('Suggested tools and connections');
    expect(emptyList).not.toMatch(/would unlock the win/i);
    expect(emptyList).toContain(DOCS_HOOK);

    const whitespaceOnly = buildTeammateBootstrapPrompt({
      displayName: 'Board Bot',
      suggestedIntegrations: [{ ...ONBOARDING_INTEGRATION_RECOMMENDATIONS.linear, name: '  ' }],
    });
    expect(whitespaceOnly).not.toContain('Suggested tools and connections');

    const absent = buildTeammateBootstrapPrompt({ displayName: 'Board Bot' });
    expect(absent).not.toContain('Suggested tools and connections');
    expect(absent).not.toMatch(/would unlock the win/i);
  });

  it('renders goal-driven guidance and the personal opener for a single goal', () => {
    const prompt = buildTeammateBootstrapPrompt({
      displayName: 'Board Bot',
      goals: ['ship-without-busywork'],
    });
    expect(prompt).toContain('What the user wants:');
    expect(prompt).toContain(findOnboardingGoal('ship-without-busywork')?.bootstrapLine ?? '');
    // A resolved goal → personal opener (act, don't interview).
    expect(prompt).toMatch(/Open as yourself: one warm line/);
    expect(prompt).toMatch(/take one concrete first-win step now and show the result/i);
    expect(prompt).not.toMatch(/ask exactly one specific question about what/i);
  });

  it('concatenates both goal lines and a bridging line for two goals', () => {
    const prompt = buildTeammateBootstrapPrompt({
      displayName: 'Board Bot',
      goals: ['hand-off-build', 'dig-into-anything'],
    });
    expect(prompt).toContain(findOnboardingGoal('hand-off-build')?.bootstrapLine ?? '');
    expect(prompt).toContain(findOnboardingGoal('dig-into-anything')?.bootstrapLine ?? '');
    expect(prompt).toMatch(/do not ask which matters more/i);
    expect(prompt).toMatch(/Open as yourself: one warm line/);
  });

  it('falls back to the single-question opener when onboarding was skipped (empty goals)', () => {
    const prompt = buildTeammateBootstrapPrompt({ displayName: 'Board Bot', goals: [] });
    // The goal block still tells the teammate to follow the user's lead...
    expect(prompt).toContain('What the user wants:');
    expect(prompt).toMatch(/follow their lead/i);
    // ...and the opener asks exactly one question rather than claiming a goal.
    expect(prompt).toMatch(/ask exactly one specific question about what/i);
    expect(prompt).not.toMatch(/Open as yourself: one warm line/);
  });

  it('does not claim a primary goal when goals resolve to nothing', () => {
    // All-unknown ids resolve to nothing → treated like a skip.
    const unknown = buildTeammateBootstrapPrompt({ displayName: 'Board Bot', goals: ['nope'] });
    expect(unknown).toMatch(/ask exactly one specific question about what/i);
    expect(unknown).not.toMatch(/Open as yourself: one warm line/);

    // Non-onboarding teammate (no goals block at all): same fallback opener.
    const nonOnboarding = buildTeammateBootstrapPrompt({ displayName: 'Board Bot' });
    expect(nonOnboarding).toMatch(/ask exactly one specific question about what/i);
    expect(nonOnboarding).not.toMatch(/Open as yourself: one warm line/);
  });
});
