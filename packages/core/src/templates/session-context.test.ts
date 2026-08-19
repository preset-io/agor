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

  it('gives Agor-native MCP guidance without fabricating providers or credentials', async () => {
    const prompt = await renderAgorSystemPrompt();

    expect(prompt).toContain('agor_mcp_servers_list');
    expect(prompt).toContain('attached_mcp_servers');
    expect(prompt).toContain('Agor User Settings → MCP Servers');
    expect(prompt).toContain('https://mcp.slack.com/mcp');
    expect(prompt).toContain('Slack `xoxp` token');
    expect(prompt).toContain('Claude connector settings');
    expect(prompt).toContain('Slack gateway channels and MCP tool access are separate systems');
    expect(prompt).toContain('do not invent an unvetted third-party server');
  });
});
