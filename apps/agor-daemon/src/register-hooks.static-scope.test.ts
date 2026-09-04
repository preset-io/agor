import type { AgorConfig } from '@agor/core/config';
import {
  createTenantScopedDatabaseProxy,
  getCurrentTenantDatabaseScope,
  MissingTenantDatabaseScopeError,
} from '@agor/core/db';
import type { HookContext } from '@agor/core/types';
import { describe, expect, it } from 'vitest';
import { type RegisterHooksContext, registerHooks } from './register-hooks.js';
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

/**
 * End-to-end wiring guard: prove `registerHooks` actually installs the
 * DB-scope around hook (not the identity-only variant) for tenant-owned
 * services in static/SQLite mode. The factory-level tests above would still
 * pass if `registerHooks` were reverted to `tenantIdentityAround`, so this test
 * captures the around hook the real registration installs and runs it.
 */
describe('registerHooks static-mode owned-service scope wiring', () => {
  type AroundHook = (ctx: HookContext, next: () => Promise<void>) => Promise<void>;

  const artifactCustomRouteProbes = [
    ['artifacts/:id/payload', 'find'],
    ['artifacts/:id/console', 'create'],
    ['artifacts/:id/sandpack-error', 'create'],
    ['artifacts/:id/runtime-response/:requestId', 'create'],
    ['artifacts/:id/trust', 'create'],
    ['me/artifact-trust-grants', 'find'],
    ['me/artifact-trust-grants', 'remove'],
  ] as const;

  /** Run registerHooks against a recorder app and return around hooks per path. */
  function captureAroundHooks(): Map<string, AroundHook[]> {
    const captured = new Map<string, AroundHook[]>();
    const app = {
      service(path: string) {
        return {
          hooks(hooks: { around?: { all?: AroundHook[] } }) {
            const key = path.replace(/^\//, '');
            const chain = hooks?.around?.all ?? [];
            captured.set(key, [...(captured.get(key) ?? []), ...chain]);
          },
        };
      },
      use() {},
      publish() {},
      io: { to: () => ({ emit() {} }) },
    };

    registerHooks({
      // Unguarded stub: registerHooks constructs repositories over this db at
      // registration time, which must not trip the guard. The scope assertion
      // below uses a SEPARATE guarded probe. `run` marks it as SQLite
      // (isPostgresDatabase keys off the absence of `.run`), so the around hook
      // opens a no-op scope rather than a native transaction.
      db: { run: () => undefined } as unknown as RegisterHooksContext['db'],
      app: app as unknown as RegisterHooksContext['app'],
      config: {
        database: { dialect: 'sqlite' },
        multi_tenancy: { mode: 'static', static_tenant_id: 'static-scope-test' },
        execution: { branch_rbac: true },
      } as RegisterHooksContext['config'],
      jwtSecret: 'static-scope-test-secret',
      deployment: { mode: 'standalone' },
      requireAuth: async (context) => context,
      superadminOpts: { allowSuperadmin: true },
      sessionsService: {} as RegisterHooksContext['sessionsService'],
      messagesService: {} as RegisterHooksContext['messagesService'],
      boardsService: undefined,
      branchRepository: {
        findById: async () => null,
      } as unknown as RegisterHooksContext['branchRepository'],
      usersRepository: {} as unknown as RegisterHooksContext['usersRepository'],
      sessionsRepository: {} as RegisterHooksContext['sessionsRepository'],
    });

    return captured;
  }

  it('installs an around hook that enters a DB scope for a tenant-owned service', async () => {
    const around = captureAroundHooks().get('boards') ?? [];
    expect(around.length).toBeGreaterThan(0);

    // A guarded probe touched inside the composed around chain: it succeeds only
    // if a tenant DB scope is active. A revert to identity-only would leave no
    // scope, so this touch would throw MissingTenantDatabaseScopeError.
    const probe = createTenantScopedDatabaseProxy({ run: () => undefined } as never, {
      label: 'wiring probe db',
    });
    let scopeKind: string | undefined;
    const innermost = async () => {
      scopeKind = getCurrentTenantDatabaseScope()?.kind;
      (probe as unknown as { run(): void }).run();
    };
    const composed = around.reduceRight<() => Promise<void>>(
      (next, hook) => () => hook({ params: {} } as unknown as HookContext, next),
      innermost
    );

    await expect(composed()).resolves.toBeUndefined();
    expect(scopeKind).toBe('tenant');
  });

  it.each(artifactCustomRouteProbes)(
    'runs %s#%s inside the guarded tenant database scope',
    async (path, method) => {
      const around = captureAroundHooks().get(path) ?? [];
      expect(around.length).toBeGreaterThan(0);

      // Exercise the installed chain instead of relying on its structural
      // arity. Any refactor that leaves identity but drops database scope will
      // trip this guarded SQLite touch, including the trust write routes.
      const probe = createTenantScopedDatabaseProxy({ run: () => undefined } as never, {
        label: `${path} wiring probe db`,
      });
      const innermost = async () => {
        (probe as unknown as { run(): void }).run();
      };
      const composed = around.reduceRight<() => Promise<void>>(
        (next, hook) => () => hook({ path, method, params: {} } as unknown as HookContext, next),
        innermost
      );

      await expect(composed()).resolves.toBeUndefined();
      expect(getCurrentTenantDatabaseScope()).toBeUndefined();
    }
  );
});
