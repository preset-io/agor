import { describe, expect, it } from 'vitest';
import {
  ASSISTANT_BOOTSTRAP_PROMPT_TEMPLATE,
  buildAssistantBootstrapPrompt,
  buildAssistantBootstrapPromptContext,
} from './assistantBootstrapPrompt';

describe('buildAssistantBootstrapPrompt', () => {
  it('renders the shared Handlebars template with assistant identity params', () => {
    const prompt = buildAssistantBootstrapPrompt({
      displayName: 'PR Reviewer',
      emoji: '🧐',
      description: 'Reviews pull requests',
      userName: 'Max',
      userEmail: 'max@example.com',
    });

    expect(ASSISTANT_BOOTSTRAP_PROMPT_TEMPLATE).toContain('{{assistant.displayName}}');
    expect(prompt).toContain('### First boot instructions for Agor Assistant');
    expect(prompt).toContain('- Assistant: PR Reviewer 🧐');
    expect(prompt).toContain('- Assistant description: Reviews pull requests');
    expect(prompt).toContain('- User: Max <max@example.com>');
    expect(prompt).toContain('- User: Max <max@example.com>\n\nRead BOOTSTRAP.md');
    expect(prompt).toContain('ask only the next useful questions');
    expect(prompt).not.toContain("don't re-ask");
  });

  it('normalizes fallback identity values in the template context', () => {
    const context = buildAssistantBootstrapPromptContext({ displayName: '  ', emoji: null });

    expect(context).toEqual({
      assistant: {
        displayName: 'My Assistant',
        emoji: '🤖',
      },
      firstSession: true,
    });
  });
});
