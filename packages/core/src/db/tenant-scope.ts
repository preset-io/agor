import { sql } from 'drizzle-orm';
import type { TenantID } from '../types/tenant';
import {
  runWithoutTenantDatabaseScope,
  type SystemDatabaseCapability,
  type TenantDatabaseScope,
  tenantContextScope,
  tenantDatabaseScope,
} from './tenant-context';

export type { SystemDatabaseCapability } from './tenant-context';
export {
  enqueueAfterTenantDatabaseCommit,
  enqueueTenantDatabasePostCommitCallback,
  getCurrentTenantDatabase,
  getCurrentTenantDatabaseScope,
  getCurrentTenantId,
  requireCurrentTenantId,
  runWithoutTenantContext,
  runWithoutTenantDatabaseScope,
  runWithTenantContext,
  tenantContextScope,
  tenantDatabaseScope,
} from './tenant-context';

import type {
  Database,
  RawDatabase,
  SystemDatabase,
  TenantScopeAwareDatabase,
  TenantScopedDatabase,
} from './client';
import { isPostgresDatabase, runDatabaseTransaction } from './database-wrapper';

const tenantScopedProxyTargets = new WeakMap<object, RawDatabase | Database>();
const tenantScopedProxyOptions = new WeakMap<object, TenantScopedDatabaseProxyOptions>();

export interface TenantScopedDatabaseProxyOptions {
  /**
   * Throw on DB access unless a tenant or explicit system DB scope is active.
   *
   * Defaults to `true`: the guard is armed in EVERY mode — SQLite, tests, dev,
   * and production — so that "touch tenant data without declaring tenancy
   * intent" fails in the cheapest environment rather than only under HA
   * `required_from_auth`. On non-Postgres a scope is a cheap AsyncLocalStorage
   * store (`runWithTenantDatabaseScope` opens no transaction), so arming it
   * everywhere costs nothing at runtime. Pass `false` only for a deliberate,
   * documented raw-access path.
   */
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

/** Inspect a raw or tenant-guarded handle without requiring an active DB scope. */
export function isPostgresDatabaseHandle(
  db: TenantScopeAwareDatabase | RawDatabase | Database
): boolean {
  return isPostgresDatabase(unwrapTenantScopedDatabaseProxy(db));
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
  // Arm the guard by default (opt-out only). See TenantScopedDatabaseProxyOptions.
  tenantScopedProxyOptions.set(base as unknown as object, {
    ...options,
    requireScope: options.requireScope !== false,
  });
  return proxy;
}

interface TenantCommitCallbacks {
  postCommit: Array<() => Promise<void>>;
  afterCommit: Array<() => Promise<void> | void>;
}

function createTenantCommitCallbacks(): TenantCommitCallbacks {
  return { postCommit: [], afterCommit: [] };
}

function resolveTenantBoundary(
  tenantId: TenantID | string | undefined,
  boundary: 'scope' | 'transaction'
): {
  existingScope: TenantDatabaseScope | undefined;
  effectiveTenantId: TenantID | string | undefined;
} {
  const operationTenantId = tenantContextScope.getStore()?.tenantId;
  if (tenantId && operationTenantId && tenantId !== operationTenantId) {
    throw new Error(
      `Cannot enter tenant database ${boundary} ${tenantId} from active tenant context ${operationTenantId}`
    );
  }

  const existingScope = tenantDatabaseScope.getStore();
  const effectiveTenantId =
    tenantId ??
    operationTenantId ??
    (existingScope?.kind === 'tenant' ? existingScope.tenantId : undefined);

  if (
    existingScope?.kind === 'tenant' &&
    effectiveTenantId &&
    existingScope.tenantId &&
    effectiveTenantId !== existingScope.tenantId
  ) {
    throw new Error(
      `Cannot enter tenant ${boundary} ${effectiveTenantId} from active tenant scope ${existingScope.tenantId}`
    );
  }

  return { existingScope, effectiveTenantId };
}

async function configurePostgresTenantScope(
  scopedDb: Database,
  baseDb: Database,
  tenantId: TenantID | string | undefined
): Promise<void> {
  if (!isPostgresDatabase(baseDb) || !tenantId) return;
  await (scopedDb as unknown as { execute(query: unknown): Promise<unknown> }).execute(
    sql`SELECT set_config('agor.tenant_id', ${tenantId}, true)`
  );
}

function enterOwnedTenantDatabaseScope<T>(
  scopedDb: Database,
  tenantId: TenantID | string | undefined,
  transactionActive: boolean,
  callbacks: TenantCommitCallbacks,
  work: (db: TenantScopedDatabase) => Promise<T>
): Promise<T> {
  return tenantDatabaseScope.run(
    {
      db: scopedDb,
      kind: 'tenant',
      tenantId,
      transactionActive,
      postCommitCallbacks: callbacks.postCommit,
      afterCommitCallbacks: callbacks.afterCommit,
    },
    () => work(scopedDb as TenantScopedDatabase)
  );
}

async function drainTenantCommitCallbacks(
  baseDb: Database,
  tenantId: TenantID | string | undefined,
  callbacks: TenantCommitCallbacks
): Promise<void> {
  await drainTenantDatabasePostCommitCallbacks(baseDb, tenantId, callbacks.postCommit);
  await drainAfterTenantDatabaseCommitCallbacks(callbacks.afterCommit);
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
  const { existingScope, effectiveTenantId } = resolveTenantBoundary(tenantId, 'scope');
  if (existingScope) {
    if (existingScope.kind === 'system') {
      if (effectiveTenantId) {
        throw new Error(
          `Cannot enter tenant scope ${effectiveTenantId} from active system database scope (${existingScope.systemReason})`
        );
      }
      return work(existingScope.db as TenantScopedDatabase);
    }
    return work(existingScope.db as TenantScopedDatabase);
  }

  const baseDb = unwrapTenantScopedDatabaseProxy(db);
  const callbacks = createTenantCommitCallbacks();

  if (!isPostgresDatabase(baseDb) || !effectiveTenantId) {
    const result = await enterOwnedTenantDatabaseScope(
      baseDb,
      effectiveTenantId,
      false,
      callbacks,
      work
    );
    await drainTenantCommitCallbacks(baseDb, effectiveTenantId, callbacks);
    return result;
  }

  const result = await baseDb.transaction(async (tx) => {
    const scopedDb = tx as unknown as Database;
    await configurePostgresTenantScope(scopedDb, baseDb, effectiveTenantId);
    return enterOwnedTenantDatabaseScope(scopedDb, effectiveTenantId, true, callbacks, work);
  });
  await drainTenantCommitCallbacks(baseDb, effectiveTenantId, callbacks);
  return result;
}

/**
 * Run one short tenant-owned metadata unit in a native database transaction on
 * both supported dialects.
 *
 * Normal SQLite request scopes intentionally carry identity only, because a
 * whole Feathers request can include slow network/process work. Callers use
 * this narrower primitive for metadata phases that must commit atomically. If
 * a PostgreSQL request already owns a transaction, the work joins it. Queued
 * realtime/deferred callbacks drain only after the native transaction commits.
 */
export async function runWithTenantDatabaseTransaction<T>(
  db: TenantScopeAwareDatabase | RawDatabase | Database,
  tenantId: TenantID | string | undefined,
  work: (db: TenantScopedDatabase) => Promise<T>,
  options: { postgresIsolationLevel?: 'repeatable read' | 'serializable' } = {}
): Promise<T> {
  const { existingScope, effectiveTenantId } = resolveTenantBoundary(tenantId, 'transaction');
  if (existingScope?.kind === 'system') {
    if (effectiveTenantId) {
      throw new Error(
        `Cannot enter tenant transaction ${effectiveTenantId} from active system database scope (${existingScope.systemReason})`
      );
    }
    throw new Error('Cannot enter a tenant transaction from an active system database scope');
  }
  if (existingScope?.kind === 'tenant' && existingScope.transactionActive) {
    return work(existingScope.db as TenantScopedDatabase);
  }

  const baseDb = unwrapTenantScopedDatabaseProxy(db);
  const callbacks = createTenantCommitCallbacks();
  const execute = () =>
    runDatabaseTransaction(
      baseDb,
      async (tx) => {
        await configurePostgresTenantScope(tx, baseDb, effectiveTenantId);
        return enterOwnedTenantDatabaseScope(tx, effectiveTenantId, true, callbacks, work);
      },
      { sqliteImmediate: true, postgresIsolationLevel: options.postgresIsolationLevel }
    );

  // SQLite requests normally have an identity-only DB scope. Temporarily leave
  // it so the repository proxy targets the new native transaction handle.
  const result = existingScope ? await runWithoutTenantDatabaseScope(execute) : await execute();
  await drainTenantCommitCallbacks(baseDb, effectiveTenantId, callbacks);
  return result;
}

async function drainAfterTenantDatabaseCommitCallbacks(
  callbacks: Array<() => Promise<void> | void>
): Promise<void> {
  for (const callback of callbacks) {
    await runWithoutTenantDatabaseScope(callback);
  }
}

/**
 * Run explicit global/system database work. This is the only supported no-tenant
 * scope for guarded database proxies; absence of tenant scope is treated as a
 * bug in required multi-tenant deployments.
 */
export async function runWithSystemDatabaseScope<T>(
  db: TenantScopeAwareDatabase | RawDatabase | Database,
  reason: string,
  work: (db: SystemDatabase) => Promise<T>,
  options: { capability?: SystemDatabaseCapability } = {}
): Promise<T> {
  const operationTenantId = tenantContextScope.getStore()?.tenantId;
  if (operationTenantId) {
    throw new Error(
      `Cannot enter system database scope (${reason}) from active tenant context ${operationTenantId}`
    );
  }
  const existingScope = tenantDatabaseScope.getStore();
  if (existingScope) {
    if (existingScope.kind === 'tenant') {
      throw new Error(
        `Cannot enter system database scope (${reason}) from active tenant scope ${existingScope.tenantId}`
      );
    }
    if (existingScope.systemCapability !== options.capability) {
      throw new Error(
        `Cannot change system database capability from ${existingScope.systemCapability ?? 'none'} to ${options.capability ?? 'none'} (${reason})`
      );
    }
    return work(existingScope.db as SystemDatabase);
  }

  const baseDb = unwrapTenantScopedDatabaseProxy(db);
  const scope = (scopedDb: Database) =>
    tenantDatabaseScope.run(
      {
        db: scopedDb,
        kind: 'system',
        systemReason: reason,
        ...(options.capability ? { systemCapability: options.capability } : {}),
      },
      () => work(scopedDb as SystemDatabase)
    );

  if (!options.capability || !isPostgresDatabase(baseDb)) {
    return scope(baseDb);
  }

  // Capabilities are transaction-local Postgres GUCs consumed by narrowly
  // scoped RLS policies. They must never leak onto a pooled connection.
  return baseDb.transaction(async (tx) => {
    const scopedDb = tx as unknown as Database;
    await (scopedDb as unknown as { execute(query: unknown): Promise<unknown> }).execute(
      sql`SELECT set_config('agor.system_scope', ${options.capability}, true)`
    );
    return scope(scopedDb);
  });
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
