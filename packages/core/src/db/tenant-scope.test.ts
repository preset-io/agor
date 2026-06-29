import { describe, expect, it, vi } from 'vitest';
import type { Database } from './client';
import { insert } from './database-wrapper';
import {
  createTenantScopedDatabaseProxy,
  getCurrentTenantId,
  MissingTenantDatabaseScopeError,
  requireCurrentTenantId,
  runWithoutTenantDatabaseScope,
  runWithSystemDatabaseScope,
  runWithTenantDatabaseScope,
} from './tenant-scope';

describe('tenant-scoped database proxy', () => {
  it('routes repository-style calls to the active tenant transaction', async () => {
    const tx = {
      execute: vi.fn(async () => []),
      marker: vi.fn(() => 'tx'),
    };
    const base = {
      transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback(tx)),
      marker: vi.fn(() => 'base'),
    };
    const db = createTenantScopedDatabaseProxy(base as unknown as Database);

    expect((db as unknown as { marker(): string }).marker()).toBe('base');

    await runWithTenantDatabaseScope(db, 'tenant-a', async () => {
      expect((db as unknown as { marker(): string }).marker()).toBe('tx');
    });

    expect(base.transaction).toHaveBeenCalledTimes(1);
    expect(tx.execute).toHaveBeenCalledTimes(1);
  });

  it('reuses the active tenant transaction for nested scopes', async () => {
    const tx = {
      execute: vi.fn(async () => []),
      marker: vi.fn(() => 'tx'),
    };
    const base = {
      transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback(tx)),
      marker: vi.fn(() => 'base'),
    };
    const db = createTenantScopedDatabaseProxy(base as unknown as Database);

    await runWithTenantDatabaseScope(db, 'tenant-a', async () => {
      expect((db as unknown as { marker(): string }).marker()).toBe('tx');
      await runWithTenantDatabaseScope(db, 'tenant-a', async () => {
        expect((db as unknown as { marker(): string }).marker()).toBe('tx');
      });
    });

    expect(base.transaction).toHaveBeenCalledTimes(1);
    expect(tx.execute).toHaveBeenCalledTimes(1);
  });

  it('rejects nested scopes that try to switch tenants', async () => {
    const tx = {
      execute: vi.fn(async () => []),
    };
    const base = {
      transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback(tx)),
    };
    const db = createTenantScopedDatabaseProxy(base as unknown as Database);

    await expect(
      runWithTenantDatabaseScope(db, 'tenant-a', async () =>
        runWithTenantDatabaseScope(db, 'tenant-b', async () => undefined)
      )
    ).rejects.toThrow(/Cannot enter tenant scope tenant-b/);

    expect(base.transaction).toHaveBeenCalledTimes(1);
  });

  it('does not recursively route to itself for SQLite no-op scopes', async () => {
    const base = {
      run: vi.fn(),
      marker: vi.fn(() => 'base'),
    };
    const db = createTenantScopedDatabaseProxy(base as unknown as Database);

    await runWithTenantDatabaseScope(db, 'tenant-a', async () => {
      expect((db as unknown as { marker(): string }).marker()).toBe('base');
    });
  });

  it('does not recursively route to itself for unscoped PostgreSQL calls', async () => {
    const base = {
      transaction: vi.fn(),
      marker: vi.fn(() => 'base'),
    };
    const db = createTenantScopedDatabaseProxy(base as unknown as Database);

    await runWithTenantDatabaseScope(db, undefined, async () => {
      expect((db as unknown as { marker(): string }).marker()).toBe('base');
    });

    expect(base.transaction).not.toHaveBeenCalled();
  });

  it('stamps tenant_id into wrapped inserts for tenant-aware tables', async () => {
    const captured: unknown[] = [];
    const tx = {
      execute: vi.fn(async () => []),
      insert: vi.fn(() => ({
        values: vi.fn((value: unknown) => {
          captured.push(value);
          return {};
        }),
      })),
    };
    const base = {
      transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback(tx)),
    };
    const db = createTenantScopedDatabaseProxy(base as unknown as Database);
    const tenantAwareTable = { tenant_id: {} } as never;

    await runWithTenantDatabaseScope(db, 'tenant-a', async () => {
      insert(db, tenantAwareTable).values({ id: 'row-1', name: 'Example' });
      insert(db, tenantAwareTable).values([
        { id: 'row-2' },
        { id: 'row-3', tenant_id: 'explicit' },
      ]);
    });

    expect(captured).toEqual([
      { tenant_id: 'tenant-a', id: 'row-1', name: 'Example' },
      [
        { tenant_id: 'tenant-a', id: 'row-2' },
        { id: 'row-3', tenant_id: 'explicit' },
      ],
    ]);
  });

  it('supports requiring and explicitly escaping the ambient tenant scope', async () => {
    const base = {
      run: vi.fn(),
    };
    const db = createTenantScopedDatabaseProxy(base as unknown as Database);
    const seen: Array<string | undefined> = [];

    await runWithTenantDatabaseScope(db, 'tenant-a', async () => {
      expect(requireCurrentTenantId()).toBe('tenant-a');
      seen.push(getCurrentTenantId());
      runWithoutTenantDatabaseScope(() => {
        seen.push(getCurrentTenantId());
        expect(() => requireCurrentTenantId()).toThrow('Missing active tenant context');
      });
      seen.push(getCurrentTenantId());
    });

    expect(seen).toEqual(['tenant-a', undefined, 'tenant-a']);
  });

  it('guarded proxies reject DB access without tenant or system scope', async () => {
    const base = {
      marker: vi.fn(() => 'base'),
    };
    const db = createTenantScopedDatabaseProxy(base as unknown as Database, {
      requireScope: true,
      label: 'test db',
    });

    expect(() => (db as unknown as { marker(): string }).marker()).toThrow(
      MissingTenantDatabaseScopeError
    );
    expect(() => (db as unknown as { marker(): string }).marker()).toThrow(
      'Missing tenant database scope for test db access'
    );
  });
  it('guarded proxies allow tenant-scoped and explicit system-scoped DB access', async () => {
    const base = {
      run: vi.fn(),
      marker: vi.fn(() => 'base'),
    };
    const db = createTenantScopedDatabaseProxy(base as unknown as Database, {
      requireScope: true,
    });

    await runWithTenantDatabaseScope(db, 'tenant-a', async () => {
      expect((db as unknown as { marker(): string }).marker()).toBe('base');
    });

    await runWithSystemDatabaseScope(db, 'test global setup', async () => {
      expect((db as unknown as { marker(): string }).marker()).toBe('base');
    });
  });

  it('does not allow switching from explicit system scope into tenant scope', async () => {
    const base = {
      marker: vi.fn(() => 'base'),
    };
    const db = createTenantScopedDatabaseProxy(base as unknown as Database, {
      requireScope: true,
    });

    await expect(
      runWithSystemDatabaseScope(db, 'test global setup', async () =>
        runWithTenantDatabaseScope(db, 'tenant-a', async () => undefined)
      )
    ).rejects.toThrow(/Cannot enter tenant scope tenant-a from active system database scope/);
  });
});
