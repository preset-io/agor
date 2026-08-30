import { createTenantScopedDatabaseProxy } from '@agor/core/db';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { McpContext } from '../server.js';
import { runWithMcpTenantDatabaseWrite } from '../tenant-scope.js';

/**
 * `runWithMcpTenantDatabaseWrite` mirrors the HTTP custom-route pair
 * `[tenantDatabaseScopeAround, tenantWriteGateAround]`: it must reject a mutation
 * with `Unavailable` while the tenant write-freeze gate is active, *before*
 * running the write. Custom (non-transport) service mutators reached over MCP —
 * `sessions.archive`/`unarchive`, `repos.cloneRepository`/`updateMetadata`,
 * `boards.archive`/`unarchive`, `repos.createBranch` — go through this helper, so
 * a frozen tenant can no longer slip a write past the gate on the MCP path.
 */

let gateActive = false;

vi.mock('@agor/core/db', async (importActual) => {
  const actual = await importActual<typeof import('@agor/core/db')>();
  return {
    ...actual,
    // Deterministic gate we can toggle per test; throws the real error type so
    // the helper's `instanceof` translation to `Unavailable` is exercised.
    assertTenantWritable: vi.fn(async (_db: unknown, tenantId: string) => {
      if (gateActive) throw new actual.TenantWriteGateActiveError(tenantId, '1');
    }),
  };
});

function makeCtx(tenantId?: string): McpContext {
  // `.run` marks the handle as SQLite-like so the scope is identity-only (no
  // native transaction to fake); the gate assertion is what's under test.
  const base = { run: () => undefined } as Record<string, unknown>;
  const db = createTenantScopedDatabaseProxy(base, {
    requireScope: true,
    label: 'daemon database',
  });
  return {
    db,
    baseServiceParams: {
      authenticated: true,
      provider: 'mcp',
      ...(tenantId ? { tenant: { tenant_id: tenantId } } : {}),
      user: { user_id: 'user-1', role: 'member' },
    },
  } as unknown as McpContext;
}

describe('runWithMcpTenantDatabaseWrite (tenant write-freeze gate)', () => {
  beforeEach(() => {
    gateActive = false;
  });

  it('rejects with Unavailable and does NOT run the write when the gate is active', async () => {
    gateActive = true;
    const work = vi.fn(async () => 'written');

    await expect(runWithMcpTenantDatabaseWrite(makeCtx('tenant-a'), work)).rejects.toMatchObject({
      // Feathers `Unavailable` — code 503; the raw TenantWriteGateActiveError is translated.
      code: 503,
    });
    expect(work).not.toHaveBeenCalled();
  });

  it('runs the write when the gate is inactive', async () => {
    const work = vi.fn(async () => 'written');
    await expect(runWithMcpTenantDatabaseWrite(makeCtx('tenant-a'), work)).resolves.toBe('written');
    expect(work).toHaveBeenCalledTimes(1);
  });

  it('preserves static single-tenant behavior (no tenant -> no gate, work runs)', async () => {
    gateActive = true; // even with an "active" gate, a request with no tenant is unscoped
    const work = vi.fn(async () => 'written');
    await expect(runWithMcpTenantDatabaseWrite(makeCtx(undefined), work)).resolves.toBe('written');
    expect(work).toHaveBeenCalledTimes(1);
  });
});
