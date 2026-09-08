import {
  createTenantScopedDatabaseProxy,
  getCurrentTenantDatabaseScope,
  getCurrentTenantId,
  MissingTenantDatabaseScopeError,
  runWithTenantContext,
} from '@agor/core/db';
import type { McpServer, ServerContext } from '@modelcontextprotocol/server';
import { describe, expect, it, vi } from 'vitest';
import { registerBranchTools } from './branches.js';

/**
 * Regression coverage for the HA/multi-tenant MCP failure:
 * `agor_branches_create` threw `Missing tenant database scope for daemon
 * database access` in `required_from_auth` mode.
 *
 * `ReposService.createBranch` is deliberately NOT a Feathers transport method,
 * so the MCP tool calls it directly — bypassing the around hooks that enter the
 * tenant database scope on the HTTP `/repos/:id/branches` route. Against a
 * `requireScope`-guarded daemon-database proxy the first `this.db` touch then
 * throws. These tests exercise the REAL guard machinery (the same
 * `createTenantScopedDatabaseProxy` / `tenantDatabaseScope` used in production)
 * rather than a stub, so removing the fix re-breaks them.
 */

vi.mock('../../utils/executor-delegated-home.js', () => ({
  resolveDelegatedExecutionHomeKey: vi.fn().mockResolvedValue(undefined),
}));

type ToolHandler = (
  args: Record<string, unknown>,
  requestContext?: ServerContext
) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;

function requestContext(): ServerContext {
  return { mcpReq: { signal: new AbortController().signal } } as ServerContext;
}

/**
 * Build a guarded daemon-database proxy exactly like `setup/database.ts` does in
 * hosted mode, plus a fake `createBranch` that TOUCHES that proxy — reproducing
 * the production access that trips the guard when no scope is active.
 */
function makeFixture(options: {
  tenantId?: string;
  requireScope?: boolean;
  branchesGet?: () => Promise<unknown>;
  /** Runs inside createBranch's tenant scope (after the guarded-db touch,
   *  before the observation is recorded) — used to interleave concurrent calls. */
  onCreate?: () => Promise<void>;
}) {
  // A `.run` marker makes `isPostgresDatabase` treat this as the SQLite-like
  // handle, so `runWithTenantDatabaseScope` enters an identity-only tenant scope
  // (no native transaction to fake). The scope still satisfies the guard — which
  // is the behavior under test. The real Postgres transaction path is covered
  // end-to-end by scripts/test-ha-mcp-branch-create.mjs.
  const base = { __daemon: true, run: () => undefined } as Record<string, unknown>;
  const guardedDb = createTenantScopedDatabaseProxy(base, {
    requireScope: options.requireScope ?? true,
    label: 'daemon database',
  });

  const observations: Array<{
    tenantIdInContext: string | undefined;
    scopeKind: string | undefined;
    scopeTenantId: string | undefined;
  }> = [];

  // Mirrors ReposService.createBranch: the first thing it does is create a
  // repository over `this.db` (the guarded proxy) and read from it. A property
  // access on the proxy is what runs `assertDatabaseScopeAllowed`.
  const createBranch = vi.fn(async () => {
    // Touch the guarded proxy — throws MissingTenantDatabaseScopeError unless a
    // tenant/system database scope is active.
    void (guardedDb as unknown as Record<string, unknown>).select;
    // Optional interleave point (still inside the tenant scope).
    if (options.onCreate) await options.onCreate();
    const scope = getCurrentTenantDatabaseScope();
    observations.push({
      tenantIdInContext: getCurrentTenantId(),
      scopeKind: scope?.kind,
      scopeTenantId: scope?.kind === 'tenant' ? scope.tenantId : undefined,
    });
    return { branch_id: 'branch-new', name: 'feature', board_id: 'board-1' };
  });

  const app = {
    get: () => ({}),
    service(name: string) {
      if (name === 'repos') {
        return {
          get: vi.fn(async () => ({ repo_id: 'repo-1', default_branch: 'main' })),
          createBranch,
        };
      }
      if (name === 'boards') return { get: vi.fn(async () => ({ board_id: 'board-1' })) };
      if (name === 'branches' && options.branchesGet) return { get: options.branchesGet };
      throw new Error(`Unexpected service call: ${name}`);
    },
  };

  const baseServiceParams = {
    authenticated: true,
    provider: 'mcp',
    ...(options.tenantId ? { tenant: { tenant_id: options.tenantId } } : {}),
    user: { user_id: 'user-1', role: 'member' },
  };

  let captured: ToolHandler | undefined;
  const fakeServer = {
    registerTool: (name: string, _cfg: unknown, cb: ToolHandler) => {
      if (name === 'agor_branches_create') captured = cb;
    },
  } as unknown as McpServer;

  registerBranchTools(fakeServer, {
    app: app as unknown as Parameters<typeof registerBranchTools>[1]['app'],
    db: guardedDb as unknown as Parameters<typeof registerBranchTools>[1]['db'],
    userId: 'user-1' as Parameters<typeof registerBranchTools>[1]['userId'],
    authenticatedUser: {
      user_id: 'user-1',
      email: 'user@example.test',
      role: 'member',
    } as Parameters<typeof registerBranchTools>[1]['authenticatedUser'],
    baseServiceParams: baseServiceParams as Parameters<
      typeof registerBranchTools
    >[1]['baseServiceParams'],
  });

  if (!captured) throw new Error('agor_branches_create was not registered');
  return { handler: captured, createBranch, observations, guardedDb };
}

const createArgs = (over: Record<string, unknown> = {}) => ({
  repoId: 'repo-1',
  branchName: 'feature',
  boardId: 'board-1',
  // Skip the auto-suffix pre-read so createBranch is the only guarded DB touch.
  autoSuffix: false,
  ...over,
});

describe('agor_branches_create tenant database scope (HA regression)', () => {
  it('locks the exact guard error string the HA daemon reported', () => {
    // The message the live HA MCP call surfaced on daemon A and B for both
    // waitForReady modes: "Missing tenant database scope for daemon database
    // access". If this label ever drifts, the symptom the fix targets changes.
    expect(new MissingTenantDatabaseScopeError('daemon database').message).toBe(
      'Missing tenant database scope for daemon database access'
    );
  });

  it('enters the authenticated tenant database scope around createBranch (waitForReady=false)', async () => {
    const { handler, createBranch, observations } = makeFixture({ tenantId: 'tenant-a' });

    const result = await handler(createArgs({ waitForReady: false }), requestContext());

    expect(result.isError).toBeFalsy();
    expect(createBranch).toHaveBeenCalledTimes(1);
    // Proves the fix: createBranch ran under an active tenant DB scope bound to
    // the authenticated tenant, not merely tenant context identity.
    expect(observations).toEqual([
      { tenantIdInContext: 'tenant-a', scopeKind: 'tenant', scopeTenantId: 'tenant-a' },
    ]);
  });

  it('does not hold the tenant database scope across the readiness wait (waitForReady=true)', async () => {
    // Wait mode reads the branch through a *separate* Feathers get; the create
    // scope must be closed by the time polling runs. Capture the ambient scope
    // *inside* the poll — the assertion below would fail if polling happened
    // while the create transaction was still open.
    let scopeDuringPoll: unknown = 'not-called';
    const branchesGet = vi.fn(async () => {
      scopeDuringPoll = getCurrentTenantDatabaseScope();
      return {
        branch_id: 'branch-new',
        name: 'feature',
        board_id: 'board-1',
        filesystem_status: 'ready',
      };
    });
    const { handler, observations } = makeFixture({ tenantId: 'tenant-a', branchesGet });

    const result = await handler(
      createArgs({ waitForReady: true, waitTimeoutMs: 2_000 }),
      requestContext()
    );

    expect(result.isError).toBeFalsy();
    expect(observations[0]).toEqual({
      tenantIdInContext: 'tenant-a',
      scopeKind: 'tenant',
      scopeTenantId: 'tenant-a',
    });
    // The readiness poll ran with NO create scope active...
    expect(branchesGet).toHaveBeenCalled();
    expect(scopeDuringPoll).toBeUndefined();
    // ...and nothing leaks past the tool boundary either.
    expect(getCurrentTenantDatabaseScope()).toBeUndefined();
  });

  it('keeps concurrent tenant A and tenant B requests on their own scopes (no cross-tenant leakage)', async () => {
    // Interleave: both createBranch calls suspend inside their own tenant scope
    // simultaneously, then each records its ambient tenant *after* the barrier.
    // AsyncLocalStorage must keep the two concurrent contexts separate.
    let enterA!: () => void;
    let enterB!: () => void;
    const aInside = new Promise<void>((resolve) => {
      enterA = resolve;
    });
    const bInside = new Promise<void>((resolve) => {
      enterB = resolve;
    });
    const a = makeFixture({
      tenantId: 'tenant-a',
      onCreate: async () => {
        enterA();
        await bInside;
      },
    });
    const b = makeFixture({
      tenantId: 'tenant-b',
      onCreate: async () => {
        enterB();
        await aInside;
      },
    });

    await Promise.all([
      a.handler(createArgs({ branchName: 'a-feature' }), requestContext()),
      b.handler(createArgs({ branchName: 'b-feature' }), requestContext()),
    ]);

    expect(a.observations[0]).toEqual({
      tenantIdInContext: 'tenant-a',
      scopeKind: 'tenant',
      scopeTenantId: 'tenant-a',
    });
    expect(b.observations[0]).toEqual({
      tenantIdInContext: 'tenant-b',
      scopeKind: 'tenant',
      scopeTenantId: 'tenant-b',
    });
  });

  it('rejects a tenant scope that conflicts with an active foreign tenant context (fail closed)', async () => {
    // If ambient identity already belongs to tenant-b, a create authenticated as
    // tenant-a must not silently switch tenants — it must fail closed.
    const { handler } = makeFixture({ tenantId: 'tenant-a' });

    await expect(
      runWithTenantContext('tenant-b', () => handler(createArgs(), requestContext()))
    ).rejects.toThrow(/tenant/i);
  });

  it('preserves static single-tenant behavior when no tenant is authenticated', async () => {
    // SQLite/static mode: proxy is not scope-requiring and no tenant is present.
    // createBranch must run without entering a tenant DB scope, exactly as today.
    const { handler, createBranch, observations } = makeFixture({
      tenantId: undefined,
      requireScope: false,
    });

    const result = await handler(createArgs(), requestContext());

    expect(result.isError).toBeFalsy();
    expect(createBranch).toHaveBeenCalledTimes(1);
    expect(observations).toEqual([
      { tenantIdInContext: undefined, scopeKind: undefined, scopeTenantId: undefined },
    ]);
  });
});
