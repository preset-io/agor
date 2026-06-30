import { createTenantScopedDatabaseProxy, MissingTenantDatabaseScopeError } from '@agor/core/db';
import { describe, expect, it, vi } from 'vitest';
import { cleanupOrphanStatuses, type StartupContext } from './startup.js';

function makeStartupContextWithGuardedDb() {
  const baseDb = {
    run: vi.fn(),
    marker: vi.fn(() => 'scoped'),
  };
  const db = createTenantScopedDatabaseProxy(baseDb as never, {
    requireScope: true,
    label: 'startup test db',
  });
  const touchDb = () => (db as unknown as { marker(): string }).marker();

  const tasksService = {
    getOrphaned: vi.fn(async () => {
      touchDb();
      return [];
    }),
    find: vi.fn(async () => {
      touchDb();
      return { data: [] };
    }),
    patch: vi.fn(),
  };
  const sessionsService = {
    find: vi.fn(async () => {
      touchDb();
      return { data: [] };
    }),
    get: vi.fn(),
    patch: vi.fn(),
  };
  const services = new Map<string, unknown>([
    ['tasks', tasksService],
    ['sessions', sessionsService],
  ]);
  const app = {
    service: vi.fn((name: string) => services.get(name)),
  };

  const ctx = {
    app,
    db,
    config: {
      multi_tenancy: {
        mode: 'required_from_auth',
        static_tenant_id: 'startup-tenant',
        auth_claim: 'tenant_id',
      },
    },
    DAEMON_PORT: 3030,
    DAEMON_HOST: 'localhost',
    svcEnabled: vi.fn(() => false),
    safeService: vi.fn(),
    getSocketServer: vi.fn(() => null),
    sessionsService,
    terminalsService: null,
  } as unknown as StartupContext;

  return { ctx, baseDb };
}

describe('startup tenant database scope', () => {
  it('runs orphan cleanup inside an explicit startup tenant DB scope', async () => {
    const { ctx, baseDb } = makeStartupContextWithGuardedDb();

    await expect(cleanupOrphanStatuses(ctx)).resolves.toMatchObject({
      orphanedTasks: [],
      orphanedSessions: [],
      queuedTasks: [],
      sessionsResetFromOrphanedTasks: 0,
    });
    expect(baseDb.marker).toHaveBeenCalled();
  });

  it('demonstrates guarded startup DB access fails without scope', () => {
    const { baseDb, ctx } = makeStartupContextWithGuardedDb();

    expect(() => (ctx.db as unknown as { marker(): string }).marker()).toThrow(
      MissingTenantDatabaseScopeError
    );
    expect(baseDb.marker).not.toHaveBeenCalled();
  });
});
