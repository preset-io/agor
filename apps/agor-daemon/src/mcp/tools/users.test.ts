import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it, vi } from 'vitest';
import { registerUserTools } from './users.js';

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

describe('user MCP tools in sessionless context', () => {
  it('agor_users_get_current works without current session context', async () => {
    const getUser = vi.fn(async () => ({
      user_id: 'user-1',
      email: 'alice@example.com',
      role: 'member',
    }));
    let handler: ToolHandler | undefined;
    const fakeServer = {
      registerTool: (name: string, _cfg: unknown, cb: ToolHandler) => {
        if (name === 'agor_users_get_current') handler = cb;
      },
    } as unknown as McpServer;

    registerUserTools(fakeServer, {
      app: {
        service: (name: string) => {
          if (name !== 'users') throw new Error(`Unexpected service: ${name}`);
          return { get: getUser };
        },
      } as any,
      db: {} as any,
      userId: 'user-1' as any,
      sessionId: undefined,
      authenticatedUser: { user_id: 'user-1', email: 'alice@example.com', role: 'member' } as any,
      baseServiceParams: {},
    });

    if (!handler) throw new Error('agor_users_get_current was not registered');
    const result = await handler({});
    const parsed = JSON.parse(result.content[0].text);

    expect(result.isError).toBeUndefined();
    expect(parsed.user_id).toBe('user-1');
    expect(getUser).toHaveBeenCalledWith('user-1', {});
  });
});
