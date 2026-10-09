import { describe, expect, it } from 'vitest';
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
    // No template → the single-question fallback opener.
    expect(prompt).toMatch(
      /ask exactly one specific question about what Max is working on right now/i
    );
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

  it('omits optional user, description and template lines when absent', () => {
    const prompt = buildTeammateBootstrapPrompt({ displayName: 'Board Bot', emoji: '🧭' });

    expect(prompt).toContain('- AI teammate: Board Bot 🧭');
    expect(prompt).not.toContain('AI teammate description:');
    expect(prompt).not.toContain('- User:');
    expect(prompt).not.toContain('- User email:');
    expect(prompt).not.toContain('Created from the');
    // With no name, the fallback opener addresses "the user".
    expect(prompt).toMatch(/what the user is working on right now/i);
    expect(prompt).not.toMatch(/\{\{\s*#?\/?\s*(assistant|user)\b/);
  });

  it('surfaces the chosen template title in Context and opens personally on template alone', () => {
    const prompt = buildTeammateBootstrapPrompt({
      displayName: 'Counsel',
      userName: 'Max',
      templateId: 'legal-analyst',
    });

    expect(prompt).toContain('- Created from the Legal Analyst template.');
    expect(prompt).toMatch(/Open as yourself: one warm line, in your persona's voice/);
    expect(prompt).toContain('set up as a Legal Analyst to help Max');
    expect(prompt).toMatch(/ground the opening in the template's remit/i);
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
});

it('keeps useful work and Knowledge first, with backup deferred only for marked local homes', () => {
  const input = { displayName: 'Ada', templateId: 'builder' };
  const local = buildTeammateBootstrapPrompt({ ...input, localHome: true });
  expect(local).toContain('Builder template');
  expect(local).toContain('Useful work comes first');
  expect(local).toContain('Agor Knowledge');
  expect(local).toContain('without origin, not privately backed up');
  expect(local).toContain('explicit user authorization');
  expect(local).toContain('Never publicly push, fork, or PR');
  expect(buildTeammateBootstrapPrompt(input)).not.toContain('not privately backed up');
});
