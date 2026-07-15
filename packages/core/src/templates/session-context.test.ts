import { describe, expect, it } from 'vitest';
import { renderAgorSystemPrompt } from './session-context';

describe('renderAgorSystemPrompt', () => {
  it('tells agents which portable and rich Markdown constructs to use', async () => {
    const prompt = await renderAgorSystemPrompt();

    expect(prompt).toContain('portable GitHub-flavored Markdown');
    expect(prompt).toContain('Mermaid, math, and GitHub callouts');
    expect(prompt).toContain('gateways such as Slack support fewer constructs');
  });
});
