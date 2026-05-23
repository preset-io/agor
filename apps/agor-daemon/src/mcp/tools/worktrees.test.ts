/**
 * Tests for the `agor_branches_*` aliases registered by `withBranchAliases`
 * in `worktrees.ts`. The §7 rename plan from
 * docs/internal/branch-vs-worktree-migration-analysis-2026-05-20.md
 * promises that every `agor_worktrees_*` tool has a sibling
 * `agor_branches_*` tool with byte-identical behavior and that calling the
 * legacy name emits a deprecation log line. Both contracts are checked here.
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

vi.mock('@agor/core/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agor/core/config')>();
  return {
    ...actual,
    isWorktreeRbacEnabled: () => false,
  };
});

vi.mock('@agor/core/db', () => ({
  // shortid-guard:ignore vi.mock factory — stand-in for the canonical shortId helper
  shortId: (id: string) => id.slice(0, 8),
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

type ToolResult = { content: Array<{ type: string; text: string }> };
// Mirrors the SDK shape — handlers receive (args, extra), where `extra` carries
// MCP request metadata (request id, progress token, etc.).
type ToolHandler = (args: Record<string, unknown>, extra?: unknown) => Promise<ToolResult>;
type ToolRegistration = { name: string; config: Record<string, unknown>; handler: ToolHandler };

function makeCtx(services: Record<string, ServiceStub>) {
  // Test stubs: shape matches McpContext closely enough for the worktree
  // handlers, but is intentionally untyped to keep the test file lean.
  return {
    app: makeFakeApp(services) as unknown as import('../server.js').McpContext['app'],
    db: {} as unknown as import('../server.js').McpContext['db'],
    userId: 'user-1' as unknown as import('../server.js').McpContext['userId'],
    sessionId: 'sess-1' as unknown as import('../server.js').McpContext['sessionId'],
    authenticatedUser: {
      user_id: 'user-1',
      role: 'admin',
    } as unknown as import('../server.js').McpContext['authenticatedUser'],
    baseServiceParams: {},
  };
}

async function captureAllWorktreeRegistrations(
  ctx: ReturnType<typeof makeCtx>
): Promise<Map<string, ToolRegistration>> {
  const { registerWorktreeTools } = await import('./worktrees.js');
  const captured = new Map<string, ToolRegistration>();
  const fakeServer = {
    registerTool: (name: string, config: Record<string, unknown>, handler: ToolHandler) => {
      captured.set(name, { name, config, handler });
    },
  } as unknown as McpServer;
  registerWorktreeTools(fakeServer, ctx);
  return captured;
}

describe('agor_branches_* aliases', () => {
  it('registers a sibling agor_branches_* tool for every agor_worktrees_* tool', async () => {
    const ctx = makeCtx({});
    const regs = await captureAllWorktreeRegistrations(ctx);

    const worktreeNames = Array.from(regs.keys())
      .filter((n) => n.startsWith('agor_worktrees_'))
      .sort();
    const branchNames = Array.from(regs.keys())
      .filter((n) => n.startsWith('agor_branches_'))
      .sort();

    // Every worktree tool gets a sibling alias.
    expect(branchNames).toEqual(
      worktreeNames.map((n) => n.replace('agor_worktrees_', 'agor_branches_'))
    );

    // The eight tools called out in the design doc are all present.
    expect(branchNames).toEqual(
      [
        'agor_branches_archive',
        'agor_branches_create',
        'agor_branches_delete',
        'agor_branches_get',
        'agor_branches_list',
        'agor_branches_set_zone',
        'agor_branches_unarchive',
        'agor_branches_update',
      ].sort()
    );

    // Same JSON Schema and annotations on both sides.
    for (const worktreeName of worktreeNames) {
      const branchName = worktreeName.replace('agor_worktrees_', 'agor_branches_');
      const wt = regs.get(worktreeName);
      const br = regs.get(branchName);
      expect(wt).toBeDefined();
      expect(br).toBeDefined();
      expect(br?.config.inputSchema).toBe(wt?.config.inputSchema);
      expect(br?.config.annotations).toEqual(wt?.config.annotations);
    }
  });

  it('marks the legacy agor_worktrees_* descriptions as deprecated and points at the alias', async () => {
    const ctx = makeCtx({});
    const regs = await captureAllWorktreeRegistrations(ctx);

    for (const [name, reg] of regs) {
      if (!name.startsWith('agor_worktrees_')) continue;
      const description = reg.config.description as string;
      const branchName = name.replace('agor_worktrees_', 'agor_branches_');
      expect(description).toMatch(/\[Deprecated alias of agor_branches_/);
      expect(description).toContain(branchName);
    }

    // The new names get the original (clean) description — no deprecation prefix.
    for (const [name, reg] of regs) {
      if (!name.startsWith('agor_branches_')) continue;
      const description = reg.config.description as string;
      expect(description).not.toMatch(/Deprecated/);
    }
  });

  it('agor_branches_list returns the same payload as agor_worktrees_list', async () => {
    const fakeWorktrees = [
      { worktree_id: 'wt-1', name: 'feat-a', repo_id: 'repo-1', archived: false },
      { worktree_id: 'wt-2', name: 'feat-b', repo_id: 'repo-1', archived: false },
    ];

    const ctx = makeCtx({
      worktrees: {
        find: async () => fakeWorktrees,
      },
    });

    const regs = await captureAllWorktreeRegistrations(ctx);
    const wtHandler = regs.get('agor_worktrees_list')?.handler;
    const brHandler = regs.get('agor_branches_list')?.handler;
    expect(wtHandler).toBeDefined();
    expect(brHandler).toBeDefined();

    const wtResult = await wtHandler!({});
    const brResult = await brHandler!({});

    expect(brResult).toEqual(wtResult);
    expect(JSON.parse(brResult.content[0].text)).toEqual(fakeWorktrees);
  });

  it('warns on the deprecation channel when agor_worktrees_list is invoked, but not for agor_branches_list', async () => {
    const ctx = makeCtx({
      worktrees: {
        find: async () => [],
      },
    });

    const regs = await captureAllWorktreeRegistrations(ctx);
    // Matches the existing deprecation-warn convention (`console.warn` with
    // an `⚠️` prefix) used elsewhere in the daemon — see
    // `logQueryParamDeprecation` in apps/agor-daemon/src/mcp/server.ts.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      await regs.get('agor_worktrees_list')!.handler({});
      const deprecationWarns = warnSpy.mock.calls
        .map((args) => args.join(' '))
        .filter((line) => line.includes('[mcp][deprecation]'));
      expect(deprecationWarns).toHaveLength(1);
      expect(deprecationWarns[0]).toContain('agor_worktrees_list');
      expect(deprecationWarns[0]).toContain('agor_branches_list');

      warnSpy.mockClear();

      await regs.get('agor_branches_list')!.handler({});
      const noDeprecationWarns = warnSpy.mock.calls
        .map((args) => args.join(' '))
        .filter((line) => line.includes('[mcp][deprecation]'));
      expect(noDeprecationWarns).toHaveLength(0);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('forwards MCP request metadata (the `extra` arg) through the deprecated wrapper', async () => {
    // The SDK calls handlers with `(args, extra)`, where `extra` carries
    // per-request metadata (request id, progress token, …). The deprecated
    // wrapper must not drop `extra` — otherwise legacy callers silently
    // lose anything the underlying handler reads from it.
    //
    // Exercise `withBranchAliases` directly on a synthetic registration so
    // we own the underlying handler and can observe what it receives.
    const { withBranchAliases } = await import('./worktrees.js');

    type Captured = { args: unknown; extra: unknown };
    const underlyingCalls: Captured[] = [];
    const underlyingHandler = async (args: unknown, extra: unknown) => {
      underlyingCalls.push({ args, extra });
      return { content: [{ type: 'text' as const, text: 'ok' }] };
    };

    const registrations: Array<{
      name: string;
      config: Record<string, unknown>;
      handler: ToolHandler;
    }> = [];
    const fakeServer = {
      registerTool: (name: string, config: Record<string, unknown>, handler: ToolHandler) => {
        registrations.push({ name, config, handler });
      },
    } as unknown as McpServer;

    const proxy = withBranchAliases(fakeServer);
    (
      proxy as unknown as {
        registerTool: (n: string, c: Record<string, unknown>, h: typeof underlyingHandler) => void;
      }
    ).registerTool('agor_worktrees_get', { description: 'probe' }, underlyingHandler);

    const legacy = registrations.find((r) => r.name === 'agor_worktrees_get');
    const alias = registrations.find((r) => r.name === 'agor_branches_get');
    expect(legacy).toBeDefined();
    expect(alias).toBeDefined();

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const probeArgs = { worktreeId: 'wt-1' };
      const probeExtra = { requestId: 'req-42', progressToken: 'tok-1' };

      // Legacy: wrapper logs + forwards both args to underlying.
      await legacy!.handler(probeArgs, probeExtra);
      expect(underlyingCalls).toHaveLength(1);
      expect(underlyingCalls[0].args).toBe(probeArgs);
      expect(underlyingCalls[0].extra).toBe(probeExtra);

      // Alias: bypass wrapper — should also forward both args (it's the
      // same underlying function, registered directly).
      await alias!.handler(probeArgs, probeExtra);
      expect(underlyingCalls).toHaveLength(2);
      expect(underlyingCalls[1].args).toBe(probeArgs);
      expect(underlyingCalls[1].extra).toBe(probeExtra);
    } finally {
      warnSpy.mockRestore();
    }
  });
});
