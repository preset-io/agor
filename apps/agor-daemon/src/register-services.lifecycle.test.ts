import type { AgorConfig } from '@agor/core/config';
import { createDatabaseAsync, createTenantScopedDatabaseProxy } from '@agor/core/db';
import { feathers, feathersExpress, socketio } from '@agor/core/feathers';
import { describe, expect, it, vi } from 'vitest';
import type { Application } from './declarations.js';
import { registerServices } from './register-services.js';

describe('registerServices application lifecycle', () => {
  it('owns the pending OAuth sweep through idempotent setup and teardown', async () => {
    vi.useFakeTimers();
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
    const rawDb = await createDatabaseAsync({ dialect: 'sqlite', url: ':memory:' });
    const db = createTenantScopedDatabaseProxy(rawDb);
    const app: Application = feathersExpress(feathers());
    app.configure(socketio());
    const config = {
      database: { dialect: 'sqlite' },
      multi_tenancy: { mode: 'static', static_tenant_id: 'lifecycle-test' },
      execution: {
        branch_rbac: false,
        allow_superadmin: false,
        unix_user_mode: 'simple',
        allow_web_terminal: false,
        bootstrap_superadmin_users: [],
      },
    } satisfies AgorConfig;
    const sweepCallIndexes = () =>
      setIntervalSpy.mock.calls.flatMap((call, index) => (call[1] === 60_000 ? [index] : []));
    const clearedCount = (handle: ReturnType<typeof setInterval>) =>
      clearIntervalSpy.mock.calls.filter(([cleared]) => cleared === handle).length;

    try {
      await registerServices({
        db,
        app,
        config,
        jwtSecret: 'register-services-lifecycle-test-secret',
        daemonUrl: 'http://localhost:3030',
        bundledUiAvailable: false,
        DAEMON_PORT: 3030,
        UI_PORT: 5173,
        branchRbacEnabled: false,
        allowSuperadmin: false,
        requireAuth: async (context) => context,
        deployment: { mode: 'standalone' },
      });
      expect(sweepCallIndexes()).toEqual([]);

      await app.setup();
      const firstSweepIndex = sweepCallIndexes()[0];
      expect(sweepCallIndexes()).toEqual([firstSweepIndex]);
      const firstSweepHandle = setIntervalSpy.mock.results[firstSweepIndex!]?.value as ReturnType<
        typeof setInterval
      >;

      await app.setup();
      expect(sweepCallIndexes()).toEqual([firstSweepIndex]);

      await app.teardown();
      expect(clearedCount(firstSweepHandle)).toBe(1);
      await app.teardown();
      expect(clearedCount(firstSweepHandle)).toBe(1);

      await app.setup();
      const restartedSweepIndex = sweepCallIndexes()[1];
      expect(sweepCallIndexes()).toEqual([firstSweepIndex, restartedSweepIndex]);
      const restartedSweepHandle = setIntervalSpy.mock.results[restartedSweepIndex!]
        ?.value as ReturnType<typeof setInterval>;
      expect(restartedSweepHandle).not.toBe(firstSweepHandle);

      await app.teardown();
      expect(clearedCount(restartedSweepHandle)).toBe(1);
    } finally {
      await app.teardown();
      vi.clearAllTimers();
      vi.useRealTimers();
      (rawDb as unknown as { $client: { close(): void } }).$client.close();
    }
  });
});
