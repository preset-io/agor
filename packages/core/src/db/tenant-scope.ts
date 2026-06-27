import { AsyncLocalStorage } from 'node:async_hooks';
import { sql } from 'drizzle-orm';
import type { TenantID } from '../types/tenant';
import type { Database } from './client';
import { isPostgresDatabase } from './database-wrapper';

interface TenantDatabaseScope {
  db: Database;
  tenantId?: TenantID | string;
}

const tenantDatabaseScope = new AsyncLocalStorage<TenantDatabaseScope>();

export function getCurrentTenantDatabase(): Database | undefined {
  return tenantDatabaseScope.getStore()?.db;
}

export function getCurrentTenantId(): TenantID | string | undefined {
  return tenantDatabaseScope.getStore()?.tenantId;
}

function scopedTarget(base: Database): Database {
  return tenantDatabaseScope.getStore()?.db ?? base;
}

/**
 * Return a Database proxy that transparently routes repository calls to the
 * current tenant-scoped transaction when one is active. Repositories can keep
 * accepting `Database` without knowing whether they are inside a tenant scope.
 */
export function createTenantScopedDatabaseProxy(base: Database): Database {
  return new Proxy(base as object, {
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
  if (!isPostgresDatabase(db) || !tenantId) {
    return tenantDatabaseScope.run({ db, tenantId }, work);
  }

  return db.transaction(async (tx) => {
    const scopedDb = tx as unknown as Database;
    await (scopedDb as unknown as { execute(query: unknown): Promise<unknown> }).execute(
      sql`SELECT set_config('agor.tenant_id', ${tenantId}, true)`
    );
    return tenantDatabaseScope.run({ db: scopedDb, tenantId }, work);
  });
}
