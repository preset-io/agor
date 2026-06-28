import { sql } from 'drizzle-orm';
import type { TenantID } from '../types/tenant';
import { tenantDatabaseScope } from './tenant-context';

export {
  enqueueTenantDatabasePostCommitCallback,
  getCurrentTenantDatabase,
  getCurrentTenantId,
  tenantDatabaseScope,
} from './tenant-context';

import type { Database } from './client';
import { isPostgresDatabase } from './database-wrapper';

const tenantScopedProxyTargets = new WeakMap<object, Database>();

function scopedTarget(base: Database): Database {
  return tenantDatabaseScope.getStore()?.db ?? base;
}

function unwrapTenantScopedDatabaseProxy(db: Database): Database {
  return tenantScopedProxyTargets.get(db as unknown as object) ?? db;
}

/**
 * Return a Database proxy that transparently routes repository calls to the
 * current tenant-scoped transaction when one is active. Repositories can keep
 * accepting `Database` without knowing whether they are inside a tenant scope.
 */
export function createTenantScopedDatabaseProxy(base: Database): Database {
  const proxy = new Proxy(base as object, {
    get(_target, property, receiver) {
      const target = scopedTarget(base) as unknown as Record<PropertyKey, unknown>;
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
    has(_target, property) {
      return property in (scopedTarget(base) as unknown as object);
    },
    ownKeys() {
      return Reflect.ownKeys(scopedTarget(base) as unknown as object);
    },
    getOwnPropertyDescriptor(_target, property) {
      return Reflect.getOwnPropertyDescriptor(scopedTarget(base) as unknown as object, property);
    },
  }) as Database;
  tenantScopedProxyTargets.set(proxy as unknown as object, base);
  return proxy;
}

/**
 * Run work inside a tenant-scoped database context. On Postgres this opens a
 * transaction and sets `agor.tenant_id` transaction-locally for RLS policies.
 * On SQLite this is a no-op scope because SQLite is static-only.
 */
export async function runWithTenantDatabaseScope<T>(
  db: Database,
  tenantId: TenantID | string | undefined,
  work: () => Promise<T>
): Promise<T> {
  const existingScope = tenantDatabaseScope.getStore();
  if (existingScope) {
    if (tenantId && existingScope.tenantId && tenantId !== existingScope.tenantId) {
      throw new Error(
        `Cannot enter tenant scope ${tenantId} from active tenant scope ${existingScope.tenantId}`
      );
    }
    return work();
  }

  const baseDb = unwrapTenantScopedDatabaseProxy(db);
  const postCommitCallbacks: Array<() => Promise<void>> = [];

  if (!isPostgresDatabase(baseDb) || !tenantId) {
    const result = await tenantDatabaseScope.run(
      { db: baseDb, tenantId, postCommitCallbacks },
      work
    );
    await drainTenantDatabasePostCommitCallbacks(baseDb, tenantId, postCommitCallbacks);
    return result;
  }

  const result = await baseDb.transaction(async (tx) => {
    const scopedDb = tx as unknown as Database;
    await (scopedDb as unknown as { execute(query: unknown): Promise<unknown> }).execute(
      sql`SELECT set_config('agor.tenant_id', ${tenantId}, true)`
    );
    return tenantDatabaseScope.run({ db: scopedDb, tenantId, postCommitCallbacks }, work);
  });
  await drainTenantDatabasePostCommitCallbacks(baseDb, tenantId, postCommitCallbacks);
  return result;
}

async function drainTenantDatabasePostCommitCallbacks(
  baseDb: Database,
  tenantId: TenantID | string | undefined,
  callbacks: Array<() => Promise<void>>
): Promise<void> {
  for (const callback of callbacks) {
    await runWithTenantDatabaseScope(baseDb, tenantId, callback);
  }
}
