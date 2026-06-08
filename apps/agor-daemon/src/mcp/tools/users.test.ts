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

  it('agor_users_list paginates, searches, and returns compact rows by default', async () => {
    const findUsers = vi.fn(async () => ({
      total: 2,
      limit: 1,
      skip: 1,
      data: [
        {
          user_id: 'user-2',
          email: 'reed@preset.io',
          name: 'Reed',
          emoji: '🎸',
          role: 'member',
          unix_username: 'reed',
          created_at: new Date('2026-01-01T00:00:00.000Z'),
          updated_at: new Date('2026-01-02T00:00:00.000Z'),
          env_vars: { SECRET: { set: true, scope: 'global' } },
          default_agentic_config: { 'claude-code': { model_config: { mode: 'alias' } } },
        },
      ],
    }));
    let handler: ToolHandler | undefined;
    const fakeServer = {
      registerTool: (name: string, _cfg: unknown, cb: ToolHandler) => {
        if (name === 'agor_users_list') handler = cb;
      },
    } as unknown as McpServer;

    registerUserTools(fakeServer, {
      app: {
        service: (name: string) => {
          if (name !== 'users') throw new Error(`Unexpected service: ${name}`);
          return { find: findUsers };
        },
      } as any,
      db: {} as any,
      userId: 'admin-1' as any,
      sessionId: undefined,
      authenticatedUser: { user_id: 'admin-1', email: 'admin@example.com', role: 'admin' } as any,
      baseServiceParams: { authenticated: true },
    });

    if (!handler) throw new Error('agor_users_list was not registered');
    const result = await handler({ limit: 1, skip: 1, search: 'reed' });
    const parsed = JSON.parse(result.content[0].text);

    expect(findUsers).toHaveBeenCalledWith({
      query: { $limit: 1, $skip: 1, search: 'reed' },
      authenticated: true,
    });
    expect(parsed).toMatchObject({ total: 2, limit: 1, skip: 1 });
    expect(parsed.data[0]).toEqual({
      user_id: 'user-2',
      email: 'reed@preset.io',
      name: 'Reed',
      emoji: '🎸',
      role: 'member',
      unix_username: 'reed',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-02T00:00:00.000Z',
    });
  });

  it('agor_users_list supports detailed and field-selected output modes', async () => {
    const detailedUser = {
      user_id: 'user-2',
      email: 'reed@preset.io',
      name: 'Reed',
      emoji: '🎸',
      role: 'member',
      unix_username: 'reed',
      created_at: new Date('2026-01-01T00:00:00.000Z'),
      env_vars: { SECRET: { set: true, scope: 'global' } },
    };
    const findUsers = vi.fn(async () => ({
      total: 1,
      limit: 50,
      skip: 0,
      data: [detailedUser],
    }));
    let handler: ToolHandler | undefined;
    const fakeServer = {
      registerTool: (name: string, _cfg: unknown, cb: ToolHandler) => {
        if (name === 'agor_users_list') handler = cb;
      },
    } as unknown as McpServer;

    registerUserTools(fakeServer, {
      app: {
        service: (name: string) => {
          if (name !== 'users') throw new Error(`Unexpected service: ${name}`);
          return { find: findUsers };
        },
      } as any,
      db: {} as any,
      userId: 'admin-1' as any,
      sessionId: undefined,
      authenticatedUser: { user_id: 'admin-1', email: 'admin@example.com', role: 'admin' } as any,
      baseServiceParams: {},
    });

    if (!handler) throw new Error('agor_users_list was not registered');

    const detailed = JSON.parse((await handler({ lean: false })).content[0].text);
    expect(detailed.data[0]).toHaveProperty('env_vars');

    const selected = JSON.parse((await handler({ fields: ['user_id', 'emoji'] })).content[0].text);
    expect(selected.data[0]).toEqual({ user_id: 'user-2', emoji: '🎸' });
  });

  it('agor_users_find returns compact matches using the search query', async () => {
    const findUsers = vi.fn(async () => ({
      total: 1,
      limit: 10,
      skip: 0,
      data: [
        {
          user_id: 'user-2',
          email: 'reed@preset.io',
          name: 'Reed',
          emoji: '🎸',
          role: 'member',
          created_at: new Date('2026-01-01T00:00:00.000Z'),
          onboarding_completed: true,
          must_change_password: false,
        },
      ],
    }));
    let handler: ToolHandler | undefined;
    const fakeServer = {
      registerTool: (name: string, _cfg: unknown, cb: ToolHandler) => {
        if (name === 'agor_users_find') handler = cb;
      },
    } as unknown as McpServer;

    registerUserTools(fakeServer, {
      app: {
        service: (name: string) => {
          if (name !== 'users') throw new Error(`Unexpected service: ${name}`);
          return { find: findUsers };
        },
      } as any,
      db: {} as any,
      userId: 'admin-1' as any,
      sessionId: undefined,
      authenticatedUser: { user_id: 'admin-1', email: 'admin@example.com', role: 'admin' } as any,
      baseServiceParams: {},
    });

    if (!handler) throw new Error('agor_users_find was not registered');
    const result = await handler({ search: 'Reed' });
    const parsed = JSON.parse(result.content[0].text);

    expect(findUsers).toHaveBeenCalledWith({
      query: { search: 'Reed', $limit: 10, $skip: 0 },
    });
    expect(parsed.data[0]).toEqual({
      user_id: 'user-2',
      email: 'reed@preset.io',
      name: 'Reed',
      emoji: '🎸',
      role: 'member',
      created_at: '2026-01-01T00:00:00.000Z',
    });
  });

  it('agor_users_find applies field-specific filters after broad service search', async () => {
    const findUsers = vi.fn(async () => ({
      total: 2,
      limit: 10000,
      skip: 0,
      data: [
        {
          user_id: 'user-2',
          email: 'reed@preset.io',
          name: 'Reed',
          emoji: '🎸',
          role: 'member',
          created_at: new Date('2026-01-01T00:00:00.000Z'),
        },
        {
          user_id: 'user-3',
          email: 'other@example.com',
          name: 'Reed Elsewhere',
          emoji: '🧪',
          role: 'member',
          created_at: new Date('2026-01-03T00:00:00.000Z'),
        },
      ],
    }));
    let handler: ToolHandler | undefined;
    const fakeServer = {
      registerTool: (name: string, _cfg: unknown, cb: ToolHandler) => {
        if (name === 'agor_users_find') handler = cb;
      },
    } as unknown as McpServer;

    registerUserTools(fakeServer, {
      app: {
        service: (name: string) => {
          if (name !== 'users') throw new Error(`Unexpected service: ${name}`);
          return { find: findUsers };
        },
      } as any,
      db: {} as any,
      userId: 'admin-1' as any,
      sessionId: undefined,
      authenticatedUser: { user_id: 'admin-1', email: 'admin@example.com', role: 'admin' } as any,
      baseServiceParams: {},
    });

    if (!handler) throw new Error('agor_users_find was not registered');
    const result = await handler({ email: 'preset.io', limit: 5 });
    const parsed = JSON.parse(result.content[0].text);

    expect(findUsers).toHaveBeenCalledWith({
      query: { search: 'preset.io', $limit: 10000, $skip: 0 },
    });
    expect(parsed.total).toBe(1);
    expect(parsed.limit).toBe(5);
    expect(parsed.data.map((user: { user_id: string }) => user.user_id)).toEqual(['user-2']);
  });
});

describe('user MCP input schemas', () => {
  it('rejects aliases and malformed required fields with caller-oriented messages', () => {
    const configs = new Map<string, { inputSchema: { safeParse: (args: unknown) => unknown } }>();
    const fakeServer = {
      registerTool: (
        name: string,
        cfg: { inputSchema: { safeParse: (args: unknown) => unknown } },
        _cb: ToolHandler
      ) => {
        configs.set(name, cfg);
      },
    } as unknown as McpServer;

    registerUserTools(fakeServer, {
      app: { service: () => ({}) } as any,
      db: {} as any,
      userId: 'admin-1' as any,
      sessionId: undefined,
      authenticatedUser: { user_id: 'admin-1', email: 'admin@example.com', role: 'admin' } as any,
      baseServiceParams: {},
    });

    const listWithAlias = configs.get('agor_users_list')?.inputSchema.safeParse({ query: 'reed' });
    expect(listWithAlias).toMatchObject({ success: false });
    expect(JSON.stringify(listWithAlias)).toContain('query');

    const badLimit = configs
      .get('agor_users_find')
      ?.inputSchema.safeParse({ search: 'reed', limit: 0 });
    expect(badLimit).toMatchObject({ success: false });
    expect(JSON.stringify(badLimit)).toContain('limit must be greater than 0');

    const emptyCreateEmail = configs
      .get('agor_user_create')
      ?.inputSchema.safeParse({ email: '', password: 'secret' });
    expect(emptyCreateEmail).toMatchObject({ success: false });
    expect(JSON.stringify(emptyCreateEmail)).toContain('email cannot be empty');

    const emptyUserId = configs.get('agor_users_get')?.inputSchema.safeParse({ userId: '' });
    expect(emptyUserId).toMatchObject({ success: false });
    expect(JSON.stringify(emptyUserId)).toContain('userId cannot be empty');
  });
});
