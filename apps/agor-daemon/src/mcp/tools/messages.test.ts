/**
 * Tests for the agor_messages_list MCP tool.
 *
 * Focus: the tool bypasses the Feathers hook pipeline by running a raw Drizzle
 * query against the messages table. These tests verify that when
 * `worktree_rbac` is enabled, the raw query is restricted to sessions the
 * caller can access (preventing cross-worktree leakage via the `search`
 * parameter).
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Hoist-safe mocks must be declared before the module under test is imported.
const mockIsWorktreeRbacEnabled = vi.fn(() => false);
const mockFindAccessibleSessions = vi.fn(async () => [] as Array<{ session_id: string }>);

vi.mock('@agor/core/config', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@agor/core/config');
  return {
    ...actual,
    isWorktreeRbacEnabled: () => mockIsWorktreeRbacEnabled(),
  };
});

// Bind the static SessionRepository constructor to a class whose instances
// delegate findAccessibleSessions to our spy.
class FakeSessionRepository {
  async findAccessibleSessions(userId: string) {
    return mockFindAccessibleSessions(userId);
  }
}

// Capture the raw query the tool builds so we can assert on its shape.
const mockWhereSpy = vi.fn();
const mockAllSpy = vi.fn(async () => [] as unknown[]);

vi.mock('@agor/core/db', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@agor/core/db');
  return {
    ...actual,
    SessionRepository: FakeSessionRepository,
    select: () => ({
      from: () => ({
        where: (cond: unknown) => {
          mockWhereSpy(cond);
          return {
            orderBy: () => ({ all: () => mockAllSpy() }),
          };
        },
      }),
    }),
  };
});

vi.mock('../resolve-ids.js', () => ({
  resolveSessionId: async (_ctx: unknown, id: string) => id,
  resolveTaskId: async (_ctx: unknown, id: string) => id,
}));

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
}>;

async function registerAndGetHandler(ctx: { userId: string; role?: string }): Promise<ToolHandler> {
  const { registerMessageTools } = await import('./messages.js');
  let captured: ToolHandler | undefined;
  const fakeServer = {
    registerTool: (_name: string, _cfg: unknown, cb: ToolHandler) => {
      captured = cb;
    },
  } as unknown as McpServer;

  registerMessageTools(fakeServer, {
    app: {} as any,
    db: {} as any,
    userId: ctx.userId as import('@agor/core/types').UserID,
    sessionId: 'sess-0001' as import('@agor/core/types').SessionID,
    authenticatedUser: { user_id: ctx.userId, role: ctx.role ?? 'member' } as any,
    baseServiceParams: {},
  });

  if (!captured) throw new Error('tool handler was not captured');
  return captured;
}

describe('agor_messages_list MCP tool', () => {
  beforeEach(() => {
    mockIsWorktreeRbacEnabled.mockReset();
    mockFindAccessibleSessions.mockReset();
    mockWhereSpy.mockReset();
    mockAllSpy.mockReset();
    mockAllSpy.mockResolvedValue([]);
    mockIsWorktreeRbacEnabled.mockReturnValue(false);
    mockFindAccessibleSessions.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('does not enforce RBAC when worktree_rbac is disabled', async () => {
    mockIsWorktreeRbacEnabled.mockReturnValue(false);
    const handler = await registerAndGetHandler({ userId: 'user-1' });
    await handler({ search: 'secret' });
    expect(mockFindAccessibleSessions).not.toHaveBeenCalled();
    expect(mockAllSpy).toHaveBeenCalled();
  });

  it('short-circuits to empty when user has no accessible sessions', async () => {
    mockIsWorktreeRbacEnabled.mockReturnValue(true);
    mockFindAccessibleSessions.mockResolvedValue([]);

    const handler = await registerAndGetHandler({ userId: 'user-1' });
    const result = await handler({ search: 'secret' });

    expect(mockFindAccessibleSessions).toHaveBeenCalledWith('user-1');
    // Query must NOT be executed when there are no accessible sessions.
    expect(mockAllSpy).not.toHaveBeenCalled();

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.messages).toEqual([]);
    expect(parsed.total).toBe(0);
  });

  it('restricts raw query to accessible session ids for regular users', async () => {
    mockIsWorktreeRbacEnabled.mockReturnValue(true);
    mockFindAccessibleSessions.mockResolvedValue([
      { session_id: 'sess-allowed-1' },
      { session_id: 'sess-allowed-2' },
    ]);

    const handler = await registerAndGetHandler({ userId: 'user-1', role: 'member' });
    await handler({ search: 'secret' });

    expect(mockFindAccessibleSessions).toHaveBeenCalledWith('user-1');
    expect(mockAllSpy).toHaveBeenCalled();
    // Drizzle builds a SQL AST; walk it with a seen-set to avoid circular
    // refs and collect every string leaf so we can assert both ids appear.
    const seen = new WeakSet<object>();
    const strings: string[] = [];
    const walk = (v: unknown) => {
      if (typeof v === 'string') {
        strings.push(v);
        return;
      }
      if (!v || typeof v !== 'object') return;
      if (seen.has(v as object)) return;
      seen.add(v as object);
      for (const val of Object.values(v as Record<string, unknown>)) walk(val);
    };
    walk(mockWhereSpy.mock.calls[0]?.[0]);
    expect(strings).toContain('sess-allowed-1');
    expect(strings).toContain('sess-allowed-2');
  });

  it('bypasses RBAC filter for superadmin role', async () => {
    mockIsWorktreeRbacEnabled.mockReturnValue(true);
    const handler = await registerAndGetHandler({ userId: 'user-1', role: 'superadmin' });
    await handler({ search: 'secret' });
    expect(mockFindAccessibleSessions).not.toHaveBeenCalled();
    expect(mockAllSpy).toHaveBeenCalled();
  });
});
