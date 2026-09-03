import type { AgorConfig } from '@agor/core/config';
import {
  createTenantScopedDatabaseProxy,
  getCurrentTenantDatabaseScope,
  MissingTenantDatabaseScopeError,
} from '@agor/core/db';
import type { HookContext } from '@agor/core/types';
import { describe, expect, it } from 'vitest';
import { createTenantDatabaseScopeAroundHook } from './utils/tenant-db-scope.js';

/**
 * Regression coverage for the static/SQLite scope-presence invariant (deliverable
 * A1). With the DB-scope guard armed in EVERY mode, a tenant-owned service
 * request in static single-tenant mode must enter a tenant DATABASE scope — not
 * merely tenant identity — or the first `this.db` touch trips
 * `MissingTenantDatabaseScopeError`. The daemon wires
 * `createTenantDatabaseScopeAroundHook(...)` (the transaction-capable variant,
 * a no-op scope on SQLite) around owned services in static mode for exactly this
 * reason; the identity-only variant (`transaction: false`) does NOT satisfy the
 * guard and is what this test proves would have failed.
 */
describe('static-mode tenant DB scope for owned services', () => {
  // Minimal config → resolveMultiTenancyConfig defaults to static mode with the
  // 'default' static tenant id. A SQLite handle is modeled as a plain object
  // (no `transaction`), so runWithTenantDatabaseScope opens the no-op scope.
  const staticConfig = {} as AgorConfig;
  const jwtSecret = 'test-secret';

  const makeGuardedSqliteDb = () =>
    createTenantScopedDatabaseProxy({ run: () => undefined } as never, {
      label: 'static daemon database',
    });

  const makeContext = (): HookContext => ({ params: {} }) as unknown as HookContext;

  it('the DB-scope around hook lets an owned-service handler touch the guarded db', async () => {
    const db = makeGuardedSqliteDb();
    const around = createTenantDatabaseScopeAroundHook({ db, config: staticConfig, jwtSecret });

    let observedScopeKind: string | undefined;
    let observedTenantId: string | undefined;
    await around(makeContext(), async () => {
      const scope = getCurrentTenantDatabaseScope();
      observedScopeKind = scope?.kind;
      observedTenantId = scope?.kind === 'tenant' ? (scope.tenantId as string) : undefined;
      // The first real DB touch a service would make. Must NOT throw.
      expect(() => (db as unknown as { run(): void }).run()).not.toThrow();
    });

    expect(observedScopeKind).toBe('tenant');
    expect(observedTenantId).toBe('default');
  });

  it('the identity-only variant leaves the guard unsatisfied (why A1 was needed)', async () => {
    const db = makeGuardedSqliteDb();
    const identityOnly = createTenantDatabaseScopeAroundHook({
      db,
      config: staticConfig,
      jwtSecret,
      transaction: false,
    });

    await expect(
      identityOnly(makeContext(), async () => {
        // Identity is present but no DB scope is active, so the guarded proxy
        // throws on the first touch — the exact pre-A1 static failure.
        (db as unknown as { run(): void }).run();
      })
    ).rejects.toBeInstanceOf(MissingTenantDatabaseScopeError);
  });
});
