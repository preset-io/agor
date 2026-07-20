import { describe, expect, it } from 'vitest';
import {
  buildTeammateBootstrapPrompt,
  buildTeammateBootstrapPromptContext,
  buildTeammateOnboardingSessionTitle,
} from './teammateBootstrapPrompt';

describe('buildTeammateBootstrapPrompt', () => {
  it('uses onboarding terminology for the visible first-session title', () => {
    expect(buildTeammateOnboardingSessionTitle({ displayName: 'Rusty', emoji: '🤖' })).toBe(
      '🤖 Rusty onboarding'
    );
    expect(buildTeammateOnboardingSessionTitle({ displayName: 'Rusty' })).toBe('Rusty onboarding');
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
    expect(prompt).toContain(
      '- User: Max <max@example.com>\n\nRead ONBOARDING.md if it exists; otherwise, read BOOTSTRAP.md'
    );
    expect(prompt).toContain('ask only the next useful question');
    expect(prompt).not.toContain("don't re-ask");
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

  it('omits optional user and description lines when absent', () => {
    const prompt = buildTeammateBootstrapPrompt({ displayName: 'Board Bot', emoji: '🧭' });

    expect(prompt).toContain('- AI teammate: Board Bot 🧭');
    expect(prompt).not.toContain('AI teammate description:');
    expect(prompt).not.toContain('- User:');
    expect(prompt).not.toContain('- User email:');
    expect(prompt).not.toContain('- User persona:');
    expect(prompt).not.toMatch(/\{\{\s*#?\/?\s*(assistant|user)\b/);
  });

  it('renders a suggested-integrations line when names are provided, and omits it when empty', () => {
    const withSuggestions = buildTeammateBootstrapPrompt({
      displayName: 'Board Bot',
      suggestedIntegrations: ['Slack', 'GitHub', 'Sentry'],
    });
    expect(withSuggestions).toContain('- Suggested integrations: Slack, GitHub, Sentry');

    // Empty / whitespace-only lists drop the line entirely.
    const emptyList = buildTeammateBootstrapPrompt({
      displayName: 'Board Bot',
      suggestedIntegrations: [],
    });
    expect(emptyList).not.toContain('Suggested integrations');

    const whitespaceOnly = buildTeammateBootstrapPrompt({
      displayName: 'Board Bot',
      suggestedIntegrations: ['  ', ''],
    });
    expect(whitespaceOnly).not.toContain('Suggested integrations');

    const absent = buildTeammateBootstrapPrompt({ displayName: 'Board Bot' });
    expect(absent).not.toContain('Suggested integrations');
  });

  it('adds a persona line with the id (plus title when known) and dumps unknown ids raw', () => {
    const known = buildTeammateBootstrapPrompt({ displayName: 'Board Bot', persona: 'developer' });
    expect(known).toContain('- User persona: developer (I write code)');

    // an id not in ONBOARDING_PERSONAS still flows through, without a title suffix
    const unknown = buildTeammateBootstrapPrompt({
      displayName: 'Board Bot',
      persona: 'architect',
    });
    expect(unknown).toContain('- User persona: architect');
    expect(unknown).not.toContain('architect (');
  });
});
