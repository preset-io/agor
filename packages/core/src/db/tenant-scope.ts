import { sql } from 'drizzle-orm';
import type { TenantID } from '../types/tenant';
import { tenantDatabaseScope } from './tenant-context';

export {
  enqueueTenantDatabasePostCommitCallback,
  getCurrentTenantDatabase,
  getCurrentTenantDatabaseScope,
  getCurrentTenantId,
  requireCurrentTenantId,
  runWithoutTenantDatabaseScope,
  tenantDatabaseScope,
} from './tenant-context';

import type {
  Database,
  RawDatabase,
  SystemDatabase,
  TenantScopeAwareDatabase,
  TenantScopedDatabase,
} from './client';
import { isPostgresDatabase } from './database-wrapper';

const tenantScopedProxyTargets = new WeakMap<object, RawDatabase | Database>();
const tenantScopedProxyOptions = new WeakMap<object, TenantScopedDatabaseProxyOptions>();

export interface TenantScopedDatabaseProxyOptions {
  /** Throw on DB access unless a tenant or explicit system DB scope is active. */
  requireScope?: boolean;
  /** Human-readable label included in guard errors. */
  label?: string;
}

export class MissingTenantDatabaseScopeError extends Error {
  constructor(label = 'database') {
    super(`Missing tenant database scope for ${label} access`);
    this.name = 'MissingTenantDatabaseScopeError';
  }
}

function assertDatabaseScopeAllowed(base: Database): void {
  const options = tenantScopedProxyOptions.get(base as unknown as object);
  if (!options?.requireScope) return;
  const store = tenantDatabaseScope.getStore();
  if (store?.kind === 'system') return;
  if (store?.kind === 'tenant' && store.tenantId) return;
  throw new MissingTenantDatabaseScopeError(options.label);
}

function scopedTarget(base: Database): Database {
  const scoped = tenantDatabaseScope.getStore()?.db;
  if (scoped) {
    assertDatabaseScopeAllowed(base);
    return scoped;
  }
  assertDatabaseScopeAllowed(base);
  return base;
}

function unwrapTenantScopedDatabaseProxy(db: Database): RawDatabase | Database {
  return tenantScopedProxyTargets.get(db as unknown as object) ?? db;
}

/**
 * Return a Database proxy that transparently routes repository calls to the
 * current tenant-scoped transaction when one is active. Repositories can keep
 * accepting `Database` without knowing whether they are inside a tenant scope.
 */
export function createTenantScopedDatabaseProxy(
  base: RawDatabase | Database,
  options: TenantScopedDatabaseProxyOptions = {}
): TenantScopeAwareDatabase {
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
  }) as TenantScopeAwareDatabase;
  tenantScopedProxyTargets.set(proxy as unknown as object, base);
  tenantScopedProxyOptions.set(base as unknown as object, options);
  return proxy;
}

/**
 * Run work inside a tenant-scoped database context. On Postgres this opens a
 * transaction and sets `agor.tenant_id` transaction-locally for RLS policies.
 * On SQLite this is a no-op scope because SQLite is static-only.
 */
export async function runWithTenantDatabaseScope<T>(
  db: TenantScopeAwareDatabase | RawDatabase | Database,
  tenantId: TenantID | string | undefined,
  work: (db: TenantScopedDatabase) => Promise<T>
): Promise<T> {
  const existingScope = tenantDatabaseScope.getStore();
  if (existingScope) {
    if (existingScope.kind === 'system') {
      if (tenantId) {
        throw new Error(
          `Cannot enter tenant scope ${tenantId} from active system database scope (${existingScope.systemReason})`
        );
      }
      return work(existingScope.db as TenantScopedDatabase);
    }
    if (tenantId && existingScope.tenantId && tenantId !== existingScope.tenantId) {
      throw new Error(
        `Cannot enter tenant scope ${tenantId} from active tenant scope ${existingScope.tenantId}`
      );
    }
    return work(existingScope.db as TenantScopedDatabase);
  }

  const baseDb = unwrapTenantScopedDatabaseProxy(db);
  const postCommitCallbacks: Array<() => Promise<void>> = [];

  if (!isPostgresDatabase(baseDb) || !tenantId) {
    const result = await tenantDatabaseScope.run(
      { db: baseDb, kind: 'tenant', tenantId, postCommitCallbacks },
      () => work(baseDb as TenantScopedDatabase)
    );
    await drainTenantDatabasePostCommitCallbacks(baseDb, tenantId, postCommitCallbacks);
    return result;
  }

  const result = await baseDb.transaction(async (tx) => {
    const scopedDb = tx as unknown as Database;
    await (scopedDb as unknown as { execute(query: unknown): Promise<unknown> }).execute(
      sql`SELECT set_config('agor.tenant_id', ${tenantId}, true)`
    );
    return tenantDatabaseScope.run(
      { db: scopedDb, kind: 'tenant', tenantId, postCommitCallbacks },
      () => work(scopedDb as TenantScopedDatabase)
    );
  });
  await drainTenantDatabasePostCommitCallbacks(baseDb, tenantId, postCommitCallbacks);
  return result;
}

/**
 * Run explicit global/system database work. This is the only supported no-tenant
 * scope for guarded database proxies; absence of tenant scope is treated as a
 * bug in required multi-tenant deployments.
 */
export async function runWithSystemDatabaseScope<T>(
  db: TenantScopeAwareDatabase | RawDatabase | Database,
  reason: string,
  work: (db: SystemDatabase) => Promise<T>
): Promise<T> {
  const existingScope = tenantDatabaseScope.getStore();
  if (existingScope) {
    if (existingScope.kind === 'tenant') {
      throw new Error(
        `Cannot enter system database scope (${reason}) from active tenant scope ${existingScope.tenantId}`
      );
    }
    return work(existingScope.db as SystemDatabase);
  }

  const baseDb = unwrapTenantScopedDatabaseProxy(db);
  return tenantDatabaseScope.run({ db: baseDb, kind: 'system', systemReason: reason }, () =>
    work(baseDb as SystemDatabase)
  );
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
