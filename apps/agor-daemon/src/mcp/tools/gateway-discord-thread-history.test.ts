import type { McpServer } from '@modelcontextprotocol/server';
import { describe, expect, it, vi } from 'vitest';
import { registerGatewayDiscordThreadHistoryTool } from './gateway-discord-thread-history.js';

const sessionId = '01933e4a-7b89-7c35-a8f3-9d2e1c4b5a6f';
const branchId = '01933e4a-7b89-7c35-a8f3-9d2e1c4b5a70';

function capture(options: { authenticated?: boolean } = {}) {
  let handler: ((args: any, context?: unknown) => Promise<any>) | undefined;
  const requestDiscordThreadHistory = vi.fn(async () => ({
    version: 1 as const,
    initial_message_id: '523456789012345678',
    through_message_id: '623456789012345678',
    messages: [
      {
        message_id: '523456789012345678',
        iso_time: '2026-08-18T12:00:00.000Z',
        actor_label: 'caller',
        text: 'untrusted content',
      },
    ],
    has_more: false,
    next_message_id: '523456789012345678',
  }));
  const server = {
    registerTool: (name: string, _config: unknown, next: typeof handler) => {
      expect(name).toBe('agor_gateway_discord_thread_history_get');
      handler = next;
    },
  } as unknown as McpServer;
  registerGatewayDiscordThreadHistoryTool(server, {
    app: { service: () => ({ requestDiscordThreadHistory }) } as never,
    db: {} as never,
    userId: '01933e4a-7b89-7c35-a8f3-9d2e1c4b5a71' as never,
    ...(options.authenticated === false
      ? {}
      : {
          sessionId: sessionId as never,
          authenticatedSession: {
            session_id: sessionId,
            branch_id: branchId,
            agentic_tool: 'codex',
          } as never,
        }),
    authenticatedUser: {} as never,
    baseServiceParams: {
      tenant: { tenant_id: 'tenant-a' },
      authenticated: true,
      provider: 'mcp',
      user: {},
    } as never,
  });
  if (!handler) throw new Error('tool was not registered');
  return { handler, requestDiscordThreadHistory };
}

describe('agor_gateway_discord_thread_history_get', () => {
  it('binds the request to the authenticated session and labels messages untrusted', async () => {
    const { handler, requestDiscordThreadHistory } = capture();
    const abort = new AbortController();
    const response = await handler(
      { limit: 50, format: 'messages', afterMessageId: '523456789012345678' },
      { signal: abort.signal }
    );
    expect(requestDiscordThreadHistory).toHaveBeenCalledWith({
      sessionId,
      branchId,
      limit: 50,
      afterMessageId: '523456789012345678',
      signal: abort.signal,
    });
    const payload = JSON.parse(response.content[0].text);
    expect(payload.warning).toMatch(/untrusted external content/i);
    expect(payload.messages[0].text).toBe('untrusted content');
    expect(payload).not.toHaveProperty('channel_id');
    expect(payload).not.toHaveProperty('thread_id');
  });

  it('supports markdown without exposing any target override', async () => {
    const { handler } = capture();
    const response = await handler({ limit: 10, format: 'markdown' });
    const payload = JSON.parse(response.content[0].text);
    expect(payload.markdown).toContain('untrusted external content');
    expect(payload.markdown).toContain('untrusted content');
    expect(payload).not.toHaveProperty('messages');
  });

  it('fails closed without authenticated session context', async () => {
    const { handler, requestDiscordThreadHistory } = capture({ authenticated: false });
    const response = await handler({ limit: 50, format: 'messages' });
    expect(response.isError).toBe(true);
    expect(requestDiscordThreadHistory).not.toHaveBeenCalled();
  });
});
