/**
 * Tests for the configuration verb `agor_environment_set` and the
 * `agor_worktrees_create({ variant })` flow that persists the initial variant
 * on a freshly-created worktree.
 *
 * `agor_environment_set` is the explicit "configure" verb that pairs with
 * `agor_environment_start`. It calls the daemon's `renderEnvironment` service
 * method (the same one the REST endpoint uses) so the variant change and the
 * materialized command strings stay in lockstep — and so the UI can reflect
 * the configured variant without any side-channel state.
 */

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
): Promise<ToolHandler> {
  const { registerEnvironmentTools } = await import('./environment.js');
  let captured: ToolHandler | undefined;
  const fakeServer = {
    registerTool: (name: string, _cfg: unknown, cb: ToolHandler) => {
      if (name === toolName) captured = cb;
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
// agor_environment_set
// ---------------------------------------------------------------------------

describe('agor_environment_set', () => {
  it('renders a stopped worktree with the requested variant and does not start', async () => {
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
          return {
            worktree_id: 'wt-1',
            environment_variant: 'e2e',
          };
        },
        startEnvironment: async (...args: unknown[]) => {
          startCalls.push(args);
          return { worktree_id: 'wt-1' };
        },
      },
    });

    const handler = await captureEnvironmentTool(ctx, 'agor_environment_set');
    const result = await handler({ worktreeId: 'wt-1', variant: 'e2e' });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.success).toBe(true);
    expect(parsed.message).toMatch(/set to "e2e"/);
    expect(renderCalls).toHaveLength(1);
    expect(renderCalls[0][1]).toEqual({ variant: 'e2e' });
    expect(startCalls).toHaveLength(0);
  });

  it('renders then starts when andStart=true', async () => {
    const renderCalls: unknown[][] = [];
    const startCalls: unknown[][] = [];

    const ctx = makeCtx({
      repos: { get: async () => fakeRepo },
      worktrees: {
        get: async () => ({
          worktree_id: 'wt-1',
          repo_id: 'repo-1',
          environment_variant: 'dev',
          environment_instance: { status: 'stopped' },
        }),
        renderEnvironment: async (...args: unknown[]) => {
          renderCalls.push(args);
          return { worktree_id: 'wt-1', environment_variant: 'e2e' };
        },
        startEnvironment: async (...args: unknown[]) => {
          startCalls.push(args);
          return { worktree_id: 'wt-1', environment_variant: 'e2e' };
        },
      },
    });

    const handler = await captureEnvironmentTool(ctx, 'agor_environment_set');
    const result = await handler({ worktreeId: 'wt-1', variant: 'e2e', andStart: true });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.success).toBe(true);
    expect(parsed.message).toMatch(/set to "e2e" and started/);
    expect(renderCalls).toHaveLength(1);
    expect(startCalls).toHaveLength(1);
  });

  it('propagates the service-layer "running" error when renderEnvironment refuses a variant change', async () => {
    // The "don't switch variants while live" invariant lives in
    // WorktreesService.renderEnvironment so REST/UI/MCP all honor it.
    // Here we verify the handler delegates and surfaces the error verbatim.
    const renderCalls: unknown[][] = [];
    const startCalls: unknown[][] = [];

    const ctx = makeCtx({
      repos: { get: async () => fakeRepo },
      worktrees: {
        get: async () => ({
          worktree_id: 'wt-1',
          repo_id: 'repo-1',
          environment_variant: 'dev',
          environment_instance: { status: 'running' },
        }),
        renderEnvironment: async (...args: unknown[]) => {
          renderCalls.push(args);
          throw new Error(
            'Cannot change environment variant to "e2e" while the environment is running ' +
              '(currently configured for "dev"). Stop the environment first.'
          );
        },
        startEnvironment: async (...args: unknown[]) => {
          startCalls.push(args);
          return {};
        },
      },
    });

    const handler = await captureEnvironmentTool(ctx, 'agor_environment_set');
    const result = await handler({ worktreeId: 'wt-1', variant: 'e2e' });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.success).toBe(false);
    expect(parsed.error).toMatch(/running/);
    expect(parsed.error).toMatch(/Stop the environment first/);
    expect(renderCalls).toHaveLength(1);
    expect(startCalls).toHaveLength(0);
  });

  it('allows re-rendering with the SAME variant on a running env (no variant change)', async () => {
    const renderCalls: unknown[][] = [];

    const ctx = makeCtx({
      repos: { get: async () => fakeRepo },
      worktrees: {
        get: async () => ({
          worktree_id: 'wt-1',
          repo_id: 'repo-1',
          environment_variant: 'dev',
          environment_instance: { status: 'running' },
        }),
        renderEnvironment: async (...args: unknown[]) => {
          renderCalls.push(args);
          return { worktree_id: 'wt-1', environment_variant: 'dev' };
        },
      },
    });

    const handler = await captureEnvironmentTool(ctx, 'agor_environment_set');
    const result = await handler({ worktreeId: 'wt-1', variant: 'dev' });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.success).toBe(true);
    expect(renderCalls).toHaveLength(1);
    expect(renderCalls[0][1]).toEqual({ variant: 'dev' });
  });

  it('returns error with available variants when variant is invalid', async () => {
    const renderCalls: unknown[][] = [];

    const ctx = makeCtx({
      repos: { get: async () => fakeRepo },
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
      },
    });

    const handler = await captureEnvironmentTool(ctx, 'agor_environment_set');
    const result = await handler({ worktreeId: 'wt-1', variant: 'nope' });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.success).toBe(false);
    expect(parsed.error).toMatch(/Invalid variant "nope"/);
    expect(parsed.error).toMatch(/dev.*e2e|e2e.*dev/);
    expect(renderCalls).toHaveLength(0);
  });

  it("omitting variant re-renders with the worktree's CURRENT variant (regression: not the repo default)", async () => {
    // Regression for the bug where the handler passed undefined to
    // renderEnvironment, which the service silently resolved to env.default —
    // flipping a non-default-variant worktree back to default on a re-render.
    // The worktree below is on 'e2e' (not the 'dev' default); omitting the
    // variant arg must re-render with 'e2e', not 'dev'.
    const renderCalls: unknown[][] = [];

    const ctx = makeCtx({
      worktrees: {
        get: async () => ({
          worktree_id: 'wt-1',
          repo_id: 'repo-1',
          environment_variant: 'e2e',
          environment_instance: { status: 'stopped' },
        }),
        renderEnvironment: async (...args: unknown[]) => {
          renderCalls.push(args);
          return { worktree_id: 'wt-1', environment_variant: 'e2e' };
        },
      },
    });

    const handler = await captureEnvironmentTool(ctx, 'agor_environment_set');
    const result = await handler({ worktreeId: 'wt-1' });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.success).toBe(true);
    expect(renderCalls).toHaveLength(1);
    expect(renderCalls[0][1]).toEqual({ variant: 'e2e' });
  });

  it('omitting variant on a legacy worktree (environment_variant=null) lets the service apply the repo default', async () => {
    const renderCalls: unknown[][] = [];

    const ctx = makeCtx({
      worktrees: {
        get: async () => ({
          worktree_id: 'wt-1',
          repo_id: 'repo-1',
          environment_variant: null,
          environment_instance: { status: 'stopped' },
        }),
        renderEnvironment: async (...args: unknown[]) => {
          renderCalls.push(args);
          return { worktree_id: 'wt-1', environment_variant: 'dev' };
        },
      },
    });

    const handler = await captureEnvironmentTool(ctx, 'agor_environment_set');
    const result = await handler({ worktreeId: 'wt-1' });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.success).toBe(true);
    expect(renderCalls).toHaveLength(1);
    expect(renderCalls[0][1]).toBeUndefined();
  });

  it('andStart=true: when render succeeds but start fails, returns variant_set:true and a clear error', async () => {
    const renderCalls: unknown[][] = [];
    const startCalls: unknown[][] = [];

    const ctx = makeCtx({
      repos: { get: async () => fakeRepo },
      worktrees: {
        get: async () => ({
          worktree_id: 'wt-1',
          repo_id: 'repo-1',
          environment_variant: 'dev',
          environment_instance: { status: 'stopped' },
        }),
        renderEnvironment: async (...args: unknown[]) => {
          renderCalls.push(args);
          return { worktree_id: 'wt-1', environment_variant: 'e2e' };
        },
        startEnvironment: async (...args: unknown[]) => {
          startCalls.push(args);
          throw new Error('docker compose returned 137');
        },
      },
    });

    const handler = await captureEnvironmentTool(ctx, 'agor_environment_set');
    const result = await handler({ worktreeId: 'wt-1', variant: 'e2e', andStart: true });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.success).toBe(false);
    expect(parsed.variant_set).toBe(true);
    expect(parsed.error).toMatch(/Variant was set to "e2e"/);
    expect(parsed.error).toMatch(/start failed: docker compose returned 137/);
    expect(renderCalls).toHaveLength(1);
    expect(startCalls).toHaveLength(1);
  });

  it('first-time variant assignment on a legacy worktree (environment_variant=null) succeeds when stopped', async () => {
    const renderCalls: unknown[][] = [];

    const ctx = makeCtx({
      repos: { get: async () => fakeRepo },
      worktrees: {
        get: async () => ({
          worktree_id: 'wt-1',
          repo_id: 'repo-1',
          environment_variant: null,
          environment_instance: { status: 'stopped' },
        }),
        renderEnvironment: async (...args: unknown[]) => {
          renderCalls.push(args);
          return { worktree_id: 'wt-1', environment_variant: 'e2e' };
        },
      },
    });

    const handler = await captureEnvironmentTool(ctx, 'agor_environment_set');
    const result = await handler({ worktreeId: 'wt-1', variant: 'e2e' });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.success).toBe(true);
    expect(renderCalls).toHaveLength(1);
    expect(renderCalls[0][1]).toEqual({ variant: 'e2e' });
  });
});

// ---------------------------------------------------------------------------
// agor_worktrees_create — variant param
// ---------------------------------------------------------------------------

describe('agor_worktrees_create', () => {
  it('passes environment_variant to createWorktree when variant is valid', async () => {
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

  it('rejects an invalid variant with the available variants in the message', async () => {
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
        variant: 'nope',
      })
    ).rejects.toThrow(/Invalid variant "nope".*dev.*e2e|Invalid variant "nope".*e2e.*dev/);

    expect(createCalls).toHaveLength(0);
  });

  it('rejects a variant when the repo has no environment.variants configured', async () => {
    const repoNoVariants = { ...fakeRepo, environment: undefined };

    const ctx = makeCtx({
      repos: {
        get: async () => repoNoVariants,
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

  it('omits environment_variant from the createWorktree payload when variant is not provided', async () => {
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
    expect(Object.hasOwn(data, 'environment_variant')).toBe(false);
  });
});
