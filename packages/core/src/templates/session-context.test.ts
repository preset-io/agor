import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import type { SessionID } from '../types/id';
import { renderAgorSessionIdentity, renderAgorSystemPrompt } from './session-context';

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

describe('renderAgorSessionIdentity', () => {
  it('uses only the current execution ID and keeps the payload stable across turns', () => {
    const original = renderAgorSessionIdentity('original-A' as SessionID);
    const fork = renderAgorSessionIdentity('fork-B' as SessionID);
    expect(fork).toBe(renderAgorSessionIdentity('fork-B' as SessionID));
    expect(fork).toContain('Current Agor session ID: fork-B');
    expect(fork).not.toContain('original-A');
    expect(renderAgorSessionIdentity('original-A' as SessionID)).toBe(original);
    expect(fork).toContain('not a fork source, spawn parent, or provider SDK thread ID');
    expect(fork).toContain('Inherited conversation and workspace IDs may be stale');
    expect(fork).toContain('enableCallback:true and omit callbackSessionId');
    expect(fork).toContain(
      'Intentional authorized alternate callbackSessionId targets remain supported'
    );
    expect(fork).toContain('(runtime-supplied)');
  });

  it('does not contaminate the shared static orientation with any execution identity', async () => {
    const before = await renderAgorSystemPrompt();
    renderAgorSessionIdentity('other-tenant-session' as SessionID);
    expect(await renderAgorSystemPrompt()).toBe(before);
    expect(before).not.toContain('other-tenant-session');
    expect(before).not.toContain('<agor_session_identity>');
  });
});

describe('shared repository instructions', () => {
  it.each(['AGENTS.md', 'CLAUDE.md'])(
    'keeps generated session identity out of %s',
    async (file) => {
      const instructions = await readFile(new URL(`../../../../${file}`, import.meta.url), 'utf8');

      expect(instructions).not.toMatch(/^## Agor Session Context\s*$/m);
      expect(instructions).not.toContain('<agor_session_identity>');
      expect(instructions).not.toMatch(
        /(?:current Agor session ID|Agor Session ID:)\s*(?:is:)?\s*[*`]*[\da-f]{8}-[\da-f-]{27}/i
      );
    }
  );
});
