import {
  createDatabaseAsync,
  createTenantScopedDatabaseProxy,
  isMCPSlackConnectCardEnabled,
  MissingTenantDatabaseScopeError,
  runMigrations,
  runWithTenantContext,
  setMCPSlackConnectCardEnabled,
  type TenantScopeAwareDatabase,
  UsersRepository,
} from '@agor/core/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTenantBoundDataAccess } from './tenant-bound-data-access';

const TENANT = 'tenant-a';

let raw: Awaited<ReturnType<typeof createDatabaseAsync>>;
/**
 * The production guard, armed — the thing the stubbed suites did not have.
 *
 * Every suite that covered the five shipped tenant-scope defects stubbed its
 * repositories, so an unscoped read had nothing to read through and no guard
 * to trip. Here the handle is a real migrated database behind
 * `requireScope: true`, which is exactly what a daemon runs with, so an access
 * that forgot to declare tenancy intent fails instead of quietly succeeding.
 */
let guarded: TenantScopeAwareDatabase;

beforeEach(async () => {
  raw = await createDatabaseAsync({ dialect: 'sqlite', url: ':memory:' });
  await runMigrations(raw);
  guarded = createTenantScopedDatabaseProxy(raw, {
    requireScope: true,
    label: 'tenant-bound data access test',
  });
});

afterEach(() => {
  (raw as unknown as { $client?: { close(): void } }).$client?.close();
});

describe('what a raw handle allowed', () => {
  it('lets an app-variable free function be called with no scope at all — and it throws', async () => {
    // `isMCPSlackConnectCardEnabled(db)` is one of the real free functions
    // behind this defect class: the kill-switch read on the first line of the
    // connect lane's delivery. From the repair sweep it ran under
    // `runWithTenantContext` only — tenant CONTEXT, no tenant DATABASE scope —
    // and threw straight into a `.catch(() => undefined)`.
    await expect(
      runWithTenantContext(TENANT, () => isMCPSlackConnectCardEnabled(guarded))
    ).rejects.toBeInstanceOf(MissingTenantDatabaseScopeError);
  });

  it('lets an unbound repository read with no scope at all — and it throws', async () => {
    const users = new UsersRepository(guarded as never);
    await expect(
      runWithTenantContext(TENANT, () => users.findByEmail('nobody@example.test'))
    ).rejects.toBeInstanceOf(MissingTenantDatabaseScopeError);
  });
});

describe('what the facade refuses to allow', () => {
  it('has no accessor that hands the underlying handle back out', () => {
    const data = createTenantBoundDataAccess(guarded);
    // The point of the type is that "pass `db` to a free function" is not
    // reachable from a holder of this object. Keep the surface at three.
    expect(Object.keys(data).sort()).toEqual(['read', 'repository', 'write']);
    for (const value of Object.values(data)) expect(typeof value).toBe('function');
  });

  it('runs the same free function through a scope, from tenant context alone', async () => {
    const data = createTenantBoundDataAccess(guarded);
    // Identical caller shape to the failing case above: identity, no scope.
    await expect(
      runWithTenantContext(TENANT, () => data.read(isMCPSlackConnectCardEnabled))
    ).resolves.toBe(true);
  });

  it('reads back what a facade write persisted, both through short units', async () => {
    const data = createTenantBoundDataAccess(guarded);
    await runWithTenantContext(TENANT, async () => {
      await data.write((db) => setMCPSlackConnectCardEnabled(db, false));
    });
    await expect(
      runWithTenantContext(TENANT, () => data.read(isMCPSlackConnectCardEnabled))
    ).resolves.toBe(false);
  });

  it('binds a repository so each method opens its own unit', async () => {
    const data = createTenantBoundDataAccess(guarded);
    const users = data.repository(new UsersRepository(guarded as never));
    await expect(
      runWithTenantContext(TENANT, () => users.findByEmail('nobody@example.test'))
    ).resolves.toBeFalsy();
  });
});

describe('the pinned tenant is not an escape hatch', () => {
  it('refuses a pin that does not say why it is stronger than ambient identity', () => {
    expect(() =>
      createTenantBoundDataAccess(guarded, {
        pinned: { pinnedTenantId: TENANT, because: '   ' },
      })
    ).toThrow(/not authorization/i);
    expect(() =>
      createTenantBoundDataAccess(guarded, {
        pinned: { pinnedTenantId: '', because: 'verified against sealed claims' },
      })
    ).toThrow(/tenant id/i);
  });

  it('reaches deferred work that ambient identity does not reach', async () => {
    const data = createTenantBoundDataAccess(guarded, {
      pinned: {
        pinnedTenantId: TENANT,
        because: 'test: a timer callback that runs outside any tenant context',
      },
    });
    // No runWithTenantContext anywhere: this is the timer/sweep shape.
    await expect(data.read(isMCPSlackConnectCardEnabled)).resolves.toBe(true);
  });

  it('still cannot cross into another tenant from inside an active context', async () => {
    const data = createTenantBoundDataAccess(guarded, {
      pinned: { pinnedTenantId: 'tenant-b', because: 'test: deliberate mismatch' },
    });
    // Pinning names a partition; it does not grant one. The scope boundary
    // still refuses to switch tenants underneath an active context.
    await expect(
      runWithTenantContext(TENANT, () => data.read(isMCPSlackConnectCardEnabled))
    ).rejects.toThrow(/Cannot enter tenant database scope/);
  });
});
