import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it, vi } from 'vitest';
import { registerBranchTools } from './branches.js';

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

function registerAndCaptureHandler(
  toolName: string,
  ctx: {
    app: unknown;
    userId: string;
    sessionId?: string;
    baseServiceParams?: Record<string, unknown>;
  }
): ToolHandler {
  let handler: ToolHandler | undefined;
  const fakeServer = {
    registerTool: (name: string, _cfg: unknown, cb: ToolHandler) => {
      if (name === toolName) handler = cb;
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

  if (!handler) throw new Error(`${toolName} was not registered`);
  return handler;
}

function registerAndCaptureUpdate(ctx: {
  app: unknown;
  userId: string;
  sessionId?: string;
  baseServiceParams?: Record<string, unknown>;
}): ToolHandler {
  return registerAndCaptureHandler('agor_branches_update', ctx);
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

describe('agor_branches_list', () => {
  const baseServiceParams = {
    authenticated: true,
    provider: 'mcp',
    user: { user_id: 'user-1', role: 'member' },
  };

  function makeApp(findResult: unknown) {
    return {
      service(name: string) {
        if (name === 'branches') return { find: vi.fn(async () => findResult) };
        throw new Error(`Unexpected service call: ${name}`);
      },
    };
  }

  it('includes zone_id and zone_label from enriched branches', async () => {
    const enrichedBranches = {
      data: [
        {
          branch_id: 'branch-1',
          name: 'my-feature',
          archived: false,
          board_id: 'board-1',
          zone_id: 'zone-1776863814461',
          zone_label: 'in progress',
          board_object_id: 'obj-1',
        },
        {
          branch_id: 'branch-2',
          name: 'other-feature',
          archived: false,
          board_id: 'board-1',
          // No zone — branch on board but not in a zone
        },
      ],
      total: 2,
      limit: 50,
      skip: 0,
    };
    const list = registerAndCaptureHandler('agor_branches_list', {
      app: makeApp(enrichedBranches),
      userId: 'user-1',
      baseServiceParams,
    });

    const result = await list({});
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content[0].text);

    const branch1 = parsed.data[0];
    expect(branch1.zone_id).toBe('zone-1776863814461');
    expect(branch1.zone_label).toBe('in progress');

    const branch2 = parsed.data[1];
    expect(branch2.zone_id).toBeUndefined();
  });

  it('filters by zoneId when provided', async () => {
    const enrichedBranches = {
      data: [
        {
          branch_id: 'branch-1',
          name: 'feature-a',
          archived: false,
          zone_id: 'zone-review',
          zone_label: 'Review',
        },
        {
          branch_id: 'branch-2',
          name: 'feature-b',
          archived: false,
          zone_id: 'zone-done',
          zone_label: 'Done',
        },
        {
          branch_id: 'branch-3',
          name: 'feature-c',
          archived: false,
          // no zone
        },
      ],
      total: 3,
      limit: 50,
      skip: 0,
    };
    const list = registerAndCaptureHandler('agor_branches_list', {
      app: makeApp(enrichedBranches),
      userId: 'user-1',
      baseServiceParams,
    });

    const result = await list({ zoneId: 'zone-review' });
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.data).toHaveLength(1);
    expect(parsed.data[0].branch_id).toBe('branch-1');
    expect(parsed.total).toBe(1);
  });

  it('returns empty data when zoneId matches no branches', async () => {
    const enrichedBranches = {
      data: [{ branch_id: 'branch-1', name: 'feature-a', zone_id: 'zone-other' }],
      total: 1,
      limit: 50,
      skip: 0,
    };
    const list = registerAndCaptureHandler('agor_branches_list', {
      app: makeApp(enrichedBranches),
      userId: 'user-1',
      baseServiceParams,
    });

    const result = await list({ zoneId: 'zone-review' });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.data).toHaveLength(0);
    expect(parsed.total).toBe(0);
  });
});
