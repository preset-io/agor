import { describe, expect, it } from 'vitest';
import {
  buildTeammateBootstrapPrompt,
  buildTeammateBootstrapPromptContext,
} from './teammateBootstrapPrompt';

describe('buildTeammateBootstrapPrompt', () => {
  it('formats teammate identity params without browser-side Handlebars rendering', () => {
    const prompt = buildTeammateBootstrapPrompt({
      displayName: 'PR Reviewer',
      emoji: '🧐',
      description: 'Reviews pull requests',
      userName: 'Max',
      userEmail: 'max@example.com',
    });

    expect(prompt).toContain('### First boot instructions for Agor AI teammate');
    expect(prompt).toContain('- AI teammate: PR Reviewer 🧐');
    expect(prompt).toContain('- AI teammate description: Reviews pull requests');
    expect(prompt).toContain('- User: Max <max@example.com>');
    expect(prompt).toContain('- User: Max <max@example.com>\n\nRead BOOTSTRAP.md');
    expect(prompt).toContain('ask only the next useful questions');
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
    expect(prompt).not.toMatch(/\{\{\s*#?\/?\s*(assistant|user)\b/);
  });
});
