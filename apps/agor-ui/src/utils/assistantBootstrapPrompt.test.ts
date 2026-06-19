import { describe, expect, it } from 'vitest';
import {
  buildAssistantBootstrapPrompt,
  buildAssistantBootstrapPromptContext,
} from './assistantBootstrapPrompt';

describe('buildAssistantBootstrapPrompt', () => {
  it('formats assistant identity params without browser-side Handlebars rendering', () => {
    const prompt = buildAssistantBootstrapPrompt({
      displayName: 'PR Reviewer',
      emoji: '🧐',
      description: 'Reviews pull requests',
      userName: 'Max',
      userEmail: 'max@example.com',
    });

    expect(prompt).toContain('### First boot instructions for Agor Assistant');
    expect(prompt).toContain('- Assistant: PR Reviewer 🧐');
    expect(prompt).toContain('- Assistant description: Reviews pull requests');
    expect(prompt).toContain('- User: Max <max@example.com>');
    expect(prompt).toContain('- User: Max <max@example.com>\n\nRead BOOTSTRAP.md');
    expect(prompt).toContain('ask only the next useful questions');
    expect(prompt).not.toContain("don't re-ask");
    expect(prompt).not.toMatch(/\{\{\s*#?\/?\s*(assistant|user)\b/);
  });

  it('normalizes fallback identity values in the prompt context', () => {
    const context = buildAssistantBootstrapPromptContext({ displayName: '  ', emoji: null });

    expect(context).toEqual({
      assistant: {
        displayName: 'My Assistant',
        emoji: '🤖',
      },
      firstSession: true,
    });
  });

  it('omits optional user and description lines when absent', () => {
    const prompt = buildAssistantBootstrapPrompt({ displayName: 'Board Bot', emoji: '🧭' });

    expect(prompt).toContain('- Assistant: Board Bot 🧭');
    expect(prompt).not.toContain('Assistant description:');
    expect(prompt).not.toContain('- User:');
    expect(prompt).not.toContain('- User email:');
    expect(prompt).not.toMatch(/\{\{\s*#?\/?\s*(assistant|user)\b/);
  });
});
