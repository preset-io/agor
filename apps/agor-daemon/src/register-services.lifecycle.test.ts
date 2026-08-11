import type { AgorConfig } from '@agor/core/config';
import { createDatabaseAsync, createTenantScopedDatabaseProxy } from '@agor/core/db';
import { feathers, feathersExpress, socketio } from '@agor/core/feathers';
import { describe, expect, it, vi } from 'vitest';
import type { Application } from './declarations.js';
import { registerServices } from './register-services.js';

describe('registerServices application lifecycle', () => {
  it('owns the pending OAuth sweep through idempotent setup and teardown', async () => {
    vi.useFakeTimers();
    const firstSweepHandle = { unref: vi.fn() } as unknown as NodeJS.Timeout;
    const restartedSweepHandle = { unref: vi.fn() } as unknown as NodeJS.Timeout;
    const sweepHandles = [firstSweepHandle, restartedSweepHandle];
    const setSweepInterval = vi.fn(() => sweepHandles.shift()!);
    const clearSweepInterval = vi.fn();
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
        pendingOAuthSweepScheduler: {
          setInterval: setSweepInterval,
          clearInterval: clearSweepInterval,
        },
      });
      expect(setSweepInterval).not.toHaveBeenCalled();

      await app.setup();
      expect(setSweepInterval).toHaveBeenCalledOnce();
      expect(setSweepInterval).toHaveBeenCalledWith(expect.any(Function), 60_000);
      expect(firstSweepHandle.unref).toHaveBeenCalledOnce();

      await app.setup();
      expect(setSweepInterval).toHaveBeenCalledOnce();

      await app.teardown();
      expect(clearSweepInterval).toHaveBeenCalledOnce();
      expect(clearSweepInterval).toHaveBeenLastCalledWith(firstSweepHandle);
      await app.teardown();
      expect(clearSweepInterval).toHaveBeenCalledOnce();

      await app.setup();
      expect(setSweepInterval).toHaveBeenCalledTimes(2);
      expect(restartedSweepHandle).not.toBe(firstSweepHandle);
      expect(restartedSweepHandle.unref).toHaveBeenCalledOnce();

      await app.teardown();
      expect(clearSweepInterval).toHaveBeenCalledTimes(2);
      expect(clearSweepInterval).toHaveBeenLastCalledWith(restartedSweepHandle);
    } finally {
      await app.teardown();
      vi.clearAllTimers();
      vi.useRealTimers();
      (rawDb as unknown as { $client: { close(): void } }).$client.close();
    }
  });
});
