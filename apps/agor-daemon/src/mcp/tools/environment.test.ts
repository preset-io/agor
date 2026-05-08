import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../resolve-ids.js', () => ({
  resolveRepoId: async (_ctx: unknown, id: string) => id,
  resolveBoardId: async (_ctx: unknown, id: string) => id,
  resolveWorktreeId: async (_ctx: unknown, id: string) => id,
  resolveSessionId: async (_ctx: unknown, id: string) => id,
  resolveMcpServerId: async (_ctx: unknown, id: string) => id,
}));

vi.mock('@agor/core/config', () => ({
  isWorktreeRbacEnabled: () => false,
}));

vi.mock('@agor/core/db', () => ({
  WorktreeRepository: class FakeWorktreeRepository {
    async getActiveNamesByRepo() {
      return [];
    }
  },
}));

type ServiceStub = Record<string, (...args: unknown[]) => unknown>;
function makeFakeApp(services: Record<string, ServiceStub>) {
  return {
    service: (name: string) => {
      const svc = services[name];
      if (!svc) throw new Error(`Unexpected service call: ${name}`);
      return svc;
    },
  };
}

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
}>;

type CapturedTool = { cfg: { inputSchema?: { parse: (v: unknown) => unknown } }; cb: ToolHandler };

function makeCtx(services: Record<string, ServiceStub>) {
  return {
    app: makeFakeApp(services) as any,
    db: {} as any,
    userId: 'user-1' as any,
    sessionId: 'sess-1' as any,
    authenticatedUser: { user_id: 'user-1', role: 'admin' } as any,
    baseServiceParams: {},
  };
}

async function captureEnvironmentTool(
  ctx: ReturnType<typeof makeCtx>,
  toolName: string
): Promise<CapturedTool> {
  const { registerEnvironmentTools } = await import('./environment.js');
  let captured: CapturedTool | undefined;
  const fakeServer = {
    registerTool: (name: string, cfg: unknown, cb: ToolHandler) => {
      if (name === toolName) captured = { cfg: cfg as CapturedTool['cfg'], cb };
    },
  } as unknown as McpServer;
  registerEnvironmentTools(fakeServer, ctx);
  if (!captured) throw new Error(`Tool ${toolName} was not registered`);
  return captured;
}

async function captureWorktreeTool(
  ctx: ReturnType<typeof makeCtx>,
  toolName: string
): Promise<ToolHandler> {
  const { registerWorktreeTools } = await import('./worktrees.js');
  let captured: ToolHandler | undefined;
  const fakeServer = {
    registerTool: (name: string, _cfg: unknown, cb: ToolHandler) => {
      if (name === toolName) captured = cb;
    },
  } as unknown as McpServer;
  registerWorktreeTools(fakeServer, ctx);
  if (!captured) throw new Error(`Tool ${toolName} was not registered`);
  return captured;
}

// ---------------------------------------------------------------------------
// Shared fixture
// ---------------------------------------------------------------------------

const fakeRepo = {
  repo_id: 'repo-1',
  slug: 'org/repo',
  local_path: '/tmp/repo',
  default_branch: 'main',
  environment: {
    version: 2,
    default: 'dev',
    variants: {
      dev: { start: 'echo dev', stop: 'echo stop' },
      e2e: { start: 'echo e2e', stop: 'echo stop' },
    },
  },
};

// ---------------------------------------------------------------------------
// agor_environment_start tests
// ---------------------------------------------------------------------------

describe('agor_environment_start', () => {
  it('1: renders environment then starts when variant differs from stored (env stopped)', async () => {
    const renderCalls: unknown[][] = [];
    const startCalls: unknown[][] = [];

    const ctx = makeCtx({
      repos: {
        get: async () => fakeRepo,
      },
      worktrees: {
        get: async () => ({
          worktree_id: 'wt-1',
          repo_id: 'repo-1',
          environment_variant: 'dev',
          environment_instance: { status: 'stopped' },
        }),
        renderEnvironment: async (...args: unknown[]) => {
          renderCalls.push(args);
          return {};
        },
        startEnvironment: async (...args: unknown[]) => {
          startCalls.push(args);
          return { worktree_id: 'wt-1', environment_variant: 'e2e' };
        },
      },
    });

    const { cb: handler } = await captureEnvironmentTool(ctx, 'agor_environment_start');
    const result = await handler({ worktreeId: 'wt-1', variant: 'e2e' });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.success).toBe(true);
    expect(renderCalls).toHaveLength(1);
    expect(renderCalls[0][1]).toEqual({ variant: 'e2e' });
    expect(startCalls).toHaveLength(1);
  });

  it('2: skips renderEnvironment when variant matches stored variant', async () => {
    const renderCalls: unknown[][] = [];
    const startCalls: unknown[][] = [];

    const ctx = makeCtx({
      repos: {
        get: async () => fakeRepo,
      },
      worktrees: {
        get: async () => ({
          worktree_id: 'wt-1',
          repo_id: 'repo-1',
          environment_variant: 'dev',
          environment_instance: { status: 'stopped' },
        }),
        renderEnvironment: async (...args: unknown[]) => {
          renderCalls.push(args);
          return {};
        },
        startEnvironment: async (...args: unknown[]) => {
          startCalls.push(args);
          return { worktree_id: 'wt-1', environment_variant: 'dev' };
        },
      },
    });

    const { cb: handler } = await captureEnvironmentTool(ctx, 'agor_environment_start');
    const result = await handler({ worktreeId: 'wt-1', variant: 'dev' });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.success).toBe(true);
    expect(renderCalls).toHaveLength(0);
    expect(startCalls).toHaveLength(1);
  });

  it('3: skips get and renderEnvironment entirely when no variant provided (backward compat)', async () => {
    const getCalls: unknown[][] = [];
    const renderCalls: unknown[][] = [];
    const startCalls: unknown[][] = [];

    const ctx = makeCtx({
      worktrees: {
        get: async (...args: unknown[]) => {
          getCalls.push(args);
          return { worktree_id: 'wt-1', environment_variant: 'dev' };
        },
        renderEnvironment: async (...args: unknown[]) => {
          renderCalls.push(args);
          return {};
        },
        startEnvironment: async (...args: unknown[]) => {
          startCalls.push(args);
          return { worktree_id: 'wt-1' };
        },
      },
    });

    const { cb: handler } = await captureEnvironmentTool(ctx, 'agor_environment_start');
    const result = await handler({ worktreeId: 'wt-1' });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.success).toBe(true);
    expect(getCalls).toHaveLength(0);
    expect(renderCalls).toHaveLength(0);
    expect(startCalls).toHaveLength(1);
  });

  it('4: returns error without calling renderEnvironment or startEnvironment when env is running with different variant', async () => {
    const renderCalls: unknown[][] = [];
    const startCalls: unknown[][] = [];

    const ctx = makeCtx({
      repos: {
        get: async () => fakeRepo,
      },
      worktrees: {
        get: async () => ({
          worktree_id: 'wt-1',
          repo_id: 'repo-1',
          environment_variant: 'dev',
          environment_instance: { status: 'running' },
        }),
        renderEnvironment: async (...args: unknown[]) => {
          renderCalls.push(args);
          return {};
        },
        startEnvironment: async (...args: unknown[]) => {
          startCalls.push(args);
          return { worktree_id: 'wt-1' };
        },
      },
    });

    const { cb: handler } = await captureEnvironmentTool(ctx, 'agor_environment_start');
    const result = await handler({ worktreeId: 'wt-1', variant: 'e2e' });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.success).toBe(false);
    expect(parsed.error).toMatch(/running/);
    expect(parsed.error).toMatch(/Stop it first/);
    expect(renderCalls).toHaveLength(0);
    expect(startCalls).toHaveLength(0);
  });

  it('5: returns error without calling renderEnvironment or startEnvironment when env is starting with different variant', async () => {
    const renderCalls: unknown[][] = [];
    const startCalls: unknown[][] = [];

    const ctx = makeCtx({
      repos: {
        get: async () => fakeRepo,
      },
      worktrees: {
        get: async () => ({
          worktree_id: 'wt-1',
          repo_id: 'repo-1',
          environment_variant: 'dev',
          environment_instance: { status: 'starting' },
        }),
        renderEnvironment: async (...args: unknown[]) => {
          renderCalls.push(args);
          return {};
        },
        startEnvironment: async (...args: unknown[]) => {
          startCalls.push(args);
          return { worktree_id: 'wt-1' };
        },
      },
    });

    const { cb: handler } = await captureEnvironmentTool(ctx, 'agor_environment_start');
    const result = await handler({ worktreeId: 'wt-1', variant: 'e2e' });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.success).toBe(false);
    expect(parsed.error).toMatch(/starting/);
    expect(parsed.error).toMatch(/Stop it first/);
    expect(renderCalls).toHaveLength(0);
    expect(startCalls).toHaveLength(0);
  });

  it('6: calls renderEnvironment then startEnvironment when environment_variant is null (legacy worktree)', async () => {
    const renderCalls: unknown[][] = [];
    const startCalls: unknown[][] = [];

    const ctx = makeCtx({
      repos: {
        get: async () => fakeRepo,
      },
      worktrees: {
        get: async () => ({
          worktree_id: 'wt-1',
          repo_id: 'repo-1',
          environment_variant: null,
          environment_instance: { status: 'stopped' },
        }),
        renderEnvironment: async (...args: unknown[]) => {
          renderCalls.push(args);
          return {};
        },
        startEnvironment: async (...args: unknown[]) => {
          startCalls.push(args);
          return { worktree_id: 'wt-1', environment_variant: 'e2e' };
        },
      },
    });

    const { cb: handler } = await captureEnvironmentTool(ctx, 'agor_environment_start');
    const result = await handler({ worktreeId: 'wt-1', variant: 'e2e' });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.success).toBe(true);
    expect(renderCalls).toHaveLength(1);
    expect(renderCalls[0][1]).toEqual({ variant: 'e2e' });
    expect(startCalls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// agor_worktrees_create tests
// ---------------------------------------------------------------------------

describe('agor_worktrees_create', () => {
  it('6: passes environment_variant to createWorktree when variant is valid', async () => {
    const createCalls: unknown[][] = [];

    const ctx = makeCtx({
      repos: {
        get: async () => fakeRepo,
        createWorktree: async (...args: unknown[]) => {
          createCalls.push(args);
          return { worktree_id: 'wt-new', name: 'my-feature' };
        },
      },
    });

    const handler = await captureWorktreeTool(ctx, 'agor_worktrees_create');
    await handler({
      repoId: 'repo-1',
      worktreeName: 'my-feature',
      boardId: 'board-1',
      variant: 'e2e',
    });

    expect(createCalls).toHaveLength(1);
    const data = createCalls[0][1] as Record<string, unknown>;
    expect(data.environment_variant).toBe('e2e');
  });

  it('7: throws error with available variants when variant is invalid', async () => {
    const createCalls: unknown[][] = [];

    const ctx = makeCtx({
      repos: {
        get: async () => fakeRepo,
        createWorktree: async (...args: unknown[]) => {
          createCalls.push(args);
          return { worktree_id: 'wt-new', name: 'my-feature' };
        },
      },
    });

    const handler = await captureWorktreeTool(ctx, 'agor_worktrees_create');
    await expect(
      handler({
        repoId: 'repo-1',
        worktreeName: 'my-feature',
        boardId: 'board-1',
        variant: 'nonexistent',
      })
    ).rejects.toThrow(/Invalid variant "nonexistent"/);

    expect(createCalls).toHaveLength(0);
  });

  it('8: error message includes available variant names', async () => {
    const ctx = makeCtx({
      repos: {
        get: async () => fakeRepo,
        createWorktree: async () => ({ worktree_id: 'wt-new', name: 'my-feature' }),
      },
    });

    const handler = await captureWorktreeTool(ctx, 'agor_worktrees_create');
    await expect(
      handler({
        repoId: 'repo-1',
        worktreeName: 'my-feature',
        boardId: 'board-1',
        variant: 'nonexistent',
      })
    ).rejects.toThrow(/dev.*e2e|e2e.*dev/);
  });

  it('9: throws with "no environment variants configured" when repo has no variants', async () => {
    const repoWithNoVariants = {
      ...fakeRepo,
      environment: {},
    };

    const ctx = makeCtx({
      repos: {
        get: async () => repoWithNoVariants,
        createWorktree: async () => ({ worktree_id: 'wt-new', name: 'my-feature' }),
      },
    });

    const handler = await captureWorktreeTool(ctx, 'agor_worktrees_create');
    await expect(
      handler({
        repoId: 'repo-1',
        worktreeName: 'my-feature',
        boardId: 'board-1',
        variant: 'e2e',
      })
    ).rejects.toThrow(/no environment variants configured/);
  });

  it('10: does not include environment_variant in createWorktree data when variant is omitted', async () => {
    const createCalls: unknown[][] = [];

    const ctx = makeCtx({
      repos: {
        get: async () => fakeRepo,
        createWorktree: async (...args: unknown[]) => {
          createCalls.push(args);
          return { worktree_id: 'wt-new', name: 'my-feature' };
        },
      },
    });

    const handler = await captureWorktreeTool(ctx, 'agor_worktrees_create');
    await handler({
      repoId: 'repo-1',
      worktreeName: 'my-feature',
      boardId: 'board-1',
    });

    expect(createCalls).toHaveLength(1);
    const data = createCalls[0][1] as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(data, 'environment_variant')).toBe(false);
  });
});
