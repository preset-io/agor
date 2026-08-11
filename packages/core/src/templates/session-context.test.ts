import { describe, expect, it } from 'vitest';
import { renderAgorSystemPrompt } from './session-context';

describe('renderAgorSystemPrompt', () => {
  it('tells agents which portable and rich Markdown constructs to use', async () => {
    const prompt = await renderAgorSystemPrompt();

    expect(prompt).toContain('portable GitHub-flavored Markdown');
    expect(prompt).toContain('Mermaid, math, and GitHub callouts');
    expect(prompt).toContain('gateways such as Slack support fewer constructs');
  });

  it('points agents at the context tool for their configured model and reasoning effort', async () => {
    const prompt = await renderAgorSystemPrompt();

    expect(prompt).toContain('configured model and');
    expect(prompt).toContain('reasoning effort');
    expect(prompt).toContain('agor_sessions_get_current_context');
  });
});
