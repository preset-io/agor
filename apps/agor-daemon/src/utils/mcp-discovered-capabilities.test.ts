import {
  createTenantScopedDatabaseProxy,
  MissingTenantDatabaseScopeError,
  type TenantScopeAwareDatabase,
  TenantWriteGateActiveError,
} from '@agor/core/db';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `/mcp-servers/discover` is registered as a tenant-identity-only service: it
 * makes outbound MCP requests, so it never inherits the request-long tenant
 * transaction that tenant-owned services get. Every database touch inside it
 * has to open its own short unit of work instead.
 *
 * Nothing in the type system says so. Against a scope-requiring handle the
 * only signal is that the guarded proxy throws on first property access, which
 * the endpoint's own try/catch turns into `{ success: false }` — a discovery
 * that reports failure after it already probed the server. So the property is
 * asserted here directly: the helper is called from no scope at all, and the
 * repository underneath it must still find one.
 */

const updateCalls: Array<{
  serverId: string;
  updates: Record<string, unknown>;
  scopeAtCall: { kind?: string; tenantId?: string } | undefined;
}> = [];

const assertTenantWritable = vi.fn<(db: unknown, tenantId: string) => Promise<void>>();

vi.mock('@agor/core/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agor/core/db')>();
  return {
    ...actual,
    assertTenantWritable: (db: unknown, tenantId: string) => assertTenantWritable(db, tenantId),
    MCPServerRepository: class {
      constructor(private db: TenantScopeAwareDatabase) {}
      async update(serverId: string, updates: Record<string, unknown>) {
        // Touch the guarded handle the way the real repository does, so a
        // missing scope fails here rather than passing silently.
        (this.db as unknown as { probe(): string }).probe();
        updateCalls.push({
          serverId,
          updates,
          scopeAtCall: actual.getCurrentTenantDatabaseScope() as
            | { kind?: string; tenantId?: string }
            | undefined,
        });
        return undefined;
      }
    },
  };
});

const { persistDiscoveredMCPCapabilities } = await import('./mcp-discovered-capabilities.js');

/**
 * `isPostgresDatabase` keys off the absence of `run`, so the `run` stub is what
 * makes this handle SQLite-shaped and keeps the scope in-process rather than
 * opening a transaction against a fake.
 */
function guardedDatabase(options: { requireScope?: boolean } = {}): TenantScopeAwareDatabase {
  const rawDb = { probe: () => 'reached', run: () => undefined };
  return createTenantScopedDatabaseProxy(rawDb as never, {
    requireScope: options.requireScope ?? true,
    label: 'discover capability test DB',
  });
}

describe('persistDiscoveredMCPCapabilities', () => {
  beforeEach(() => {
    updateCalls.length = 0;
    assertTenantWritable.mockReset();
    assertTenantWritable.mockResolvedValue(undefined);
  });

  it('opens a tenant unit of work around the capability write', async () => {
    const db = guardedDatabase();

    // The guard is real: the same access from the endpoint's own call frame,
    // outside any scope of its own, is refused.
    expect(() => (db as unknown as { probe(): string }).probe()).toThrow(
      MissingTenantDatabaseScopeError
    );

    await persistDiscoveredMCPCapabilities(db, 'tenant-a', 'server-1', {
      tools: [{ name: 'search', description: 'Search' }],
      resources: [],
      prompts: [],
    });

    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].scopeAtCall).toMatchObject({ kind: 'tenant', tenantId: 'tenant-a' });
  });

  it('clears the per-tenant write gate before writing', async () => {
    await persistDiscoveredMCPCapabilities(guardedDatabase(), 'tenant-a', 'server-1', {
      tools: [],
      resources: [],
      prompts: [],
    });

    expect(assertTenantWritable).toHaveBeenCalledWith(expect.anything(), 'tenant-a');
  });

  it('writes nothing while the tenant is frozen', async () => {
    assertTenantWritable.mockRejectedValue(new TenantWriteGateActiveError('tenant-a', 'gen-1'));

    await expect(
      persistDiscoveredMCPCapabilities(guardedDatabase(), 'tenant-a', 'server-1', {
        tools: [{ name: 'search', description: 'Search' }],
        resources: [],
        prompts: [],
      })
    ).rejects.toBeInstanceOf(TenantWriteGateActiveError);

    expect(updateCalls).toHaveLength(0);
  });

  it('writes each capability list, defaulting a list the probe did not return to empty', async () => {
    await persistDiscoveredMCPCapabilities(guardedDatabase(), 'tenant-a', 'server-1', {
      tools: [{ name: 'search', description: 'Search' }],
    });

    expect(updateCalls[0].serverId).toBe('server-1');
    expect(updateCalls[0].updates).toEqual({
      tools: [{ name: 'search', description: 'Search' }],
      resources: [],
      prompts: [],
    });
  });

  it('carries no ownership field, so a refresh cannot move the row between owners', async () => {
    await persistDiscoveredMCPCapabilities(guardedDatabase(), 'tenant-a', 'server-1', {
      tools: [],
      resources: [],
      prompts: [],
    });

    expect(Object.keys(updateCalls[0].updates).sort()).toEqual(['prompts', 'resources', 'tools']);
  });

  it('still writes when there is no tenant to scope to, as on single-tenant SQLite', async () => {
    await persistDiscoveredMCPCapabilities(
      guardedDatabase({ requireScope: false }),
      undefined,
      'server-1',
      { tools: [], resources: [], prompts: [] }
    );

    expect(updateCalls).toHaveLength(1);
    expect(assertTenantWritable).not.toHaveBeenCalled();
  });
});
