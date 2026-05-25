import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it, vi } from 'vitest';
import { registerBranchTools } from './branches.js';

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

function registerAndCaptureUpdate(ctx: {
  app: unknown;
  userId: string;
  sessionId?: string;
  baseServiceParams?: Record<string, unknown>;
}): ToolHandler {
  let handler: ToolHandler | undefined;
  const fakeServer = {
    registerTool: (name: string, _cfg: unknown, cb: ToolHandler) => {
      if (name === 'agor_branches_update') handler = cb;
    },
  } as unknown as McpServer;

  registerBranchTools(fakeServer, {
    app: ctx.app as Parameters<typeof registerBranchTools>[1]['app'],
    db: {} as Parameters<typeof registerBranchTools>[1]['db'],
    userId: ctx.userId as Parameters<typeof registerBranchTools>[1]['userId'],
    sessionId: ctx.sessionId as Parameters<typeof registerBranchTools>[1]['sessionId'],
    authenticatedUser: { user_id: ctx.userId, role: 'member' } as Parameters<
      typeof registerBranchTools
    >[1]['authenticatedUser'],
    baseServiceParams: (ctx.baseServiceParams ?? {}) as Parameters<
      typeof registerBranchTools
    >[1]['baseServiceParams'],
  });

  if (!handler) throw new Error('agor_branches_update was not registered');
  return handler;
}

describe('agor_branches_update', () => {
  it('uses authenticated service params when falling back to the current session branch', async () => {
    const baseServiceParams = {
      authenticated: true,
      provider: 'mcp',
      user: { user_id: 'user-1', role: 'member' },
    };
    const sessionsGet = vi.fn(async () => ({ session_id: 'session-1', branch_id: 'branch-1' }));
    const branchesPatch = vi.fn(async () => ({ branch_id: 'branch-1', notes: 'updated' }));
    const app = {
      service(name: string) {
        if (name === 'sessions') return { get: sessionsGet };
        if (name === 'branches') return { patch: branchesPatch };
        throw new Error(`Unexpected service call: ${name}`);
      },
    };

    const update = registerAndCaptureUpdate({
      app,
      userId: 'user-1',
      sessionId: 'session-1',
      baseServiceParams,
    });

    await update({ notes: 'updated' });

    expect(sessionsGet).toHaveBeenCalledWith('session-1', baseServiceParams);
    expect(branchesPatch).toHaveBeenCalledWith('branch-1', { notes: 'updated' }, baseServiceParams);
  });

  it('returns an actionable error when branchId is omitted without session context', async () => {
    const sessionsGet = vi.fn();
    const app = {
      service(name: string) {
        if (name === 'sessions') return { get: sessionsGet };
        throw new Error(`Unexpected service call: ${name}`);
      },
    };

    const update = registerAndCaptureUpdate({ app, userId: 'user-1' });
    const result = await update({ notes: 'updated' });
    const parsed = JSON.parse(result.content[0].text);

    expect(result.isError).toBe(true);
    expect(parsed.error).toMatch(/requires current Agor session context/i);
    expect(parsed.error).toMatch(/X-Agor-Session-Id/);
    expect(sessionsGet).not.toHaveBeenCalled();
  });
});
