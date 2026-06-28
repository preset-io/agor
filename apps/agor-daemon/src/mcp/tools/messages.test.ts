/**
 * Tests for the agor_messages_list MCP tool.
 *
 * Focus: the tool bypasses the Feathers hook pipeline by running a raw Drizzle
 * query against the messages table. These tests verify that when
 * `branch_rbac` is enabled, the raw query uses the shared visible-session SQL
 * predicate (preventing cross-branch leakage via the `search` parameter).
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Hoist-safe mocks must be declared before the module under test is imported.
const mockIsBranchRbacEnabled = vi.fn(() => false);
const mockVisibleSessionReferenceAccessExists = vi.fn();

vi.mock('@agor/core/config', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@agor/core/config');
  return {
    ...actual,
    isBranchRbacEnabled: () => mockIsBranchRbacEnabled(),
  };
});

// Capture the raw query the tool builds so we can assert on its shape.
const mockWhereSpy = vi.fn();
const mockAllSpy = vi.fn(async () => [] as unknown[]);

vi.mock('@agor/core/db', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@agor/core/db');
  return {
    ...actual,
    visibleSessionReferenceAccessExists: (...args: unknown[]) => {
      mockVisibleSessionReferenceAccessExists(...args);
      return actual.sql`visible-session-access`;
    },
    select: () => ({
      from: () => ({
        where: (cond: unknown) => {
          mockWhereSpy(cond);
          return {
            orderBy: () => ({
              limit: () => ({ offset: () => ({ all: () => mockAllSpy() }) }),
            }),
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

type CapturedTool = {
  cfg: { inputSchema?: { parse: (v: unknown) => unknown; safeParse: (v: unknown) => any } };
  cb: ToolHandler;
};

const recentIso = () => new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

function row(index: number, text = `message ${index}`) {
  return {
    message_id: `message-${index}`,
    session_id: 'sess-0001',
    task_id: null,
    type: 'user',
    role: 'user',
    index,
    timestamp: new Date('2026-06-01T00:00:00Z'),
    content_preview: text,
    data: { content: text },
  };
}

async function registerAndGetTool(ctx: { userId: string; role?: string }): Promise<CapturedTool> {
  const { registerMessageTools } = await import('./messages.js');
  let captured: CapturedTool | undefined;
  const fakeServer = {
    registerTool: (_name: string, cfg: unknown, cb: ToolHandler) => {
      captured = { cfg: cfg as CapturedTool['cfg'], cb };
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

async function registerAndGetHandler(ctx: { userId: string; role?: string }): Promise<ToolHandler> {
  return (await registerAndGetTool(ctx)).cb;
}

describe('agor_messages_list MCP tool', () => {
  beforeEach(() => {
    mockIsBranchRbacEnabled.mockReset();
    mockVisibleSessionReferenceAccessExists.mockReset();
    mockWhereSpy.mockReset();
    mockAllSpy.mockReset();
    mockAllSpy.mockResolvedValue([]);
    mockIsBranchRbacEnabled.mockReturnValue(false);
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('surfaces clearer validation for malformed ids and pagination', async () => {
    const tool = await registerAndGetTool({ userId: 'user-1' });
    const schema = tool.cfg.inputSchema!;

    const badSessionId = schema.safeParse({ sessionId: 123 });
    expect(badSessionId.success).toBe(false);
    expect(String(badSessionId.error.message)).toMatch(/sessionId must be a string/);

    const badLimit = schema.safeParse({ search: 'secret', limit: -1 });
    expect(badLimit.success).toBe(false);
    expect(String(badLimit.error.message)).toMatch(/limit must be greater than 0/);

    const badOffset = schema.safeParse({ search: 'secret', offset: -1 });
    expect(badOffset.success).toBe(false);
    expect(String(badOffset.error.message)).toMatch(/offset must be greater than or equal to 0/);
  });

  it('keeps the handler-level search scope check actionable', async () => {
    const handler = await registerAndGetHandler({ userId: 'user-1' });

    await expect(handler({})).rejects.toThrow(
      /At least one of sessionId, taskId, or search must be provided as a non-empty string/
    );
  });

  it('validates createdAfter and createdBefore dates', async () => {
    const handler = await registerAndGetHandler({ userId: 'user-1' });

    await expect(handler({ search: 'secret', createdAfter: 'not-a-date' })).rejects.toThrow(
      /createdAfter must be a valid ISO-8601 date string/
    );

    await expect(
      handler({
        search: 'secret',
        createdAfter: '2026-06-02T00:00:00Z',
        createdBefore: '2026-06-01T00:00:00Z',
      })
    ).rejects.toThrow(/createdAfter must be earlier than or equal to createdBefore/);
  });

  it('fails fast for broad cross-session keyword search without time bounds', async () => {
    const handler = await registerAndGetHandler({ userId: 'user-1' });

    await expect(handler({ search: 'secret' })).rejects.toThrow(
      /Broad cross-session message search must be scoped/
    );
    expect(mockAllSpy).not.toHaveBeenCalled();
  });

  it('fails fast for broad cross-session keyword search with an over-wide window', async () => {
    const handler = await registerAndGetHandler({ userId: 'user-1' });

    await expect(
      handler({
        search: 'secret',
        createdAfter: '2026-01-01T00:00:00Z',
        createdBefore: '2026-03-15T00:00:00Z',
      })
    ).rejects.toThrow(/window of 31 days or less/);
    expect(mockAllSpy).not.toHaveBeenCalled();
  });

  it('does not enforce RBAC when branch_rbac is disabled', async () => {
    mockIsBranchRbacEnabled.mockReturnValue(false);
    const handler = await registerAndGetHandler({ userId: 'user-1' });
    await handler({ search: 'secret', createdAfter: recentIso() });
    expect(mockVisibleSessionReferenceAccessExists).not.toHaveBeenCalled();
    expect(mockAllSpy).toHaveBeenCalled();
  });

  it('restricts raw query through the shared visible-session EXISTS predicate', async () => {
    mockIsBranchRbacEnabled.mockReturnValue(true);

    const handler = await registerAndGetHandler({ userId: 'user-1', role: 'member' });
    await handler({ search: 'secret', createdAfter: recentIso() });

    expect(mockVisibleSessionReferenceAccessExists).toHaveBeenCalledTimes(1);
    expect(mockVisibleSessionReferenceAccessExists.mock.calls[0]?.[1]).toBe('user-1');
    expect(mockAllSpy).toHaveBeenCalled();
  });

  it('bypasses RBAC filter for superadmin role', async () => {
    mockIsBranchRbacEnabled.mockReturnValue(true);
    const handler = await registerAndGetHandler({ userId: 'user-1', role: 'superadmin' });
    await handler({ search: 'secret', createdAfter: recentIso() });
    expect(mockVisibleSessionReferenceAccessExists).not.toHaveBeenCalled();
    expect(mockAllSpy).toHaveBeenCalled();
  });

  it('allows browsing a specific session transcript without a time bound', async () => {
    const handler = await registerAndGetHandler({ userId: 'user-1' });

    await handler({ sessionId: 'sess-0001' });

    expect(mockAllSpy).toHaveBeenCalled();
  });

  it('sets next_offset to the raw rows consumed for the returned page', async () => {
    mockAllSpy.mockResolvedValue([row(0), row(1), row(2)]);
    const handler = await registerAndGetHandler({ userId: 'user-1' });

    const result = await handler({ sessionId: 'sess-0001', limit: 2 });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.messages.map((m: { index: number }) => m.index)).toEqual([0, 1]);
    expect(parsed.returned).toBe(2);
    expect(parsed.has_more).toBe(true);
    expect(parsed.next_offset).toBe(2);
  });
});
