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

/**
 * Proxy → raw handle, shared across bundled copies of this module for the same
 * reason the scope stores are (see `processScopeStore` in `tenant-context.ts`).
 * A private map here would silently stop unwrapping any proxy built by another
 * entry point, sending `isPostgresDatabaseHandle` through the guarded trap it
 * exists to avoid.
 */
const tenantScopedProxyTargets = ((): WeakMap<object, RawDatabase | Database> => {
  const registry = globalThis as typeof globalThis & Record<symbol, unknown>;
  const symbol = Symbol.for('agor.db.tenant-scoped-proxy-targets');
  const existing = registry[symbol];
  if (existing) return existing as WeakMap<object, RawDatabase | Database>;
  const created = new WeakMap<object, RawDatabase | Database>();
  registry[symbol] = created;
  return created;
})();

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

function assertDatabaseScopeAllowed(
  scope: TenantDatabaseScope | undefined,
  options: TenantScopedDatabaseProxyOptions
): void {
  if (!options.requireScope) return;
  if (scope?.kind === 'system') return;
  if (scope?.kind === 'tenant' && scope.tenantId) return;
  throw new MissingTenantDatabaseScopeError(options.label);
}

function scopedTarget(base: Database, options: TenantScopedDatabaseProxyOptions): Database {
  // Fenced on database identity, not merely on "a scope is open". The stores
  // are the process's, so without this a proxy over one database served the
  // handle of whatever database happened to own the ambient scope.
  const scope = activeScopeForDatabase(base);
  assertDatabaseScopeAllowed(scope, options);
  return scope?.db ?? base;
}

/**
 * Fully unwrap a guarded proxy to the handle it was built over.
 *
 * Iterative because a proxy may wrap a proxy (two guard settings over one
 * base), and bounded because a hostile/broken entry must not spin: the map is
 * only ever written by `createTenantScopedDatabaseProxy`, so a real chain is
 * one or two links.
 */
function databaseRootHandle(
  db: TenantScopeAwareDatabase | RawDatabase | Database
): RawDatabase | Database {
  let current = db as RawDatabase | Database;
  for (let hop = 0; hop < 16; hop++) {
    const next = tenantScopedProxyTargets.get(current as unknown as object);
    if (!next || next === current) break;
    current = next;
  }
  return current;
}

/**
 * May this scope answer for this database?
 *
 * Two handles name the same database here: the base the scope was opened on
 * (`rootDb`), and the scoped handle the scope itself produced (`db`) — a
 * PostgreSQL transaction, or on SQLite the base again. The second case is what
 * lets a caller pass a handle it received *from* a scope back into one of these
 * entry points without being told it belongs to some other database.
 */
function scopeServesDatabase(
  scope: TenantDatabaseScope,
  db: TenantScopeAwareDatabase | RawDatabase | Database
): boolean {
  const root = databaseRootHandle(db) as unknown as object;
  return (scope.rootDb as unknown as object) === root || (scope.db as unknown as object) === root;
}

/**
 * The ambient scope, but only when it belongs to the database being asked
 * about. A scope opened for one database must never serve another — neither by
 * routing a proxy's property access nor by admitting a nested scope.
 */
function activeScopeForDatabase(
  db: TenantScopeAwareDatabase | RawDatabase | Database
): TenantDatabaseScope | undefined {
  const scope = tenantDatabaseScope.getStore();
  if (!scope) return undefined;
  return scopeServesDatabase(scope, db) ? scope : undefined;
}

/** Inspect a raw or tenant-guarded handle without requiring an active DB scope. */
export function isPostgresDatabaseHandle(
  db: TenantScopeAwareDatabase | RawDatabase | Database
): boolean {
  return isPostgresDatabase(databaseRootHandle(db));
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
  // Normalize once and close over it PER PROXY. Options must not be keyed by the
  // shared base handle: two proxies can wrap the same handle with different
  // guard settings, and a later opt-out wrapper must never disarm an earlier
  // guarded proxy. Arm the guard by default (opt-out only) — see
  // TenantScopedDatabaseProxyOptions.
  const proxyOptions: TenantScopedDatabaseProxyOptions = {
    ...options,
    requireScope: options.requireScope !== false,
  };
  const proxy = new Proxy(base as object, {
    get(_target, property, receiver) {
      const target = scopedTarget(base, proxyOptions) as unknown as Record<PropertyKey, unknown>;
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
    has(_target, property) {
      return property in (scopedTarget(base, proxyOptions) as unknown as object);
    },
    ownKeys() {
      return Reflect.ownKeys(scopedTarget(base, proxyOptions) as unknown as object);
    },
    getOwnPropertyDescriptor(_target, property) {
      return Reflect.getOwnPropertyDescriptor(
        scopedTarget(base, proxyOptions) as unknown as object,
        property
      );
    },
  }) as TenantScopeAwareDatabase;
  tenantScopedProxyTargets.set(proxy as unknown as object, base);
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
  db: TenantScopeAwareDatabase | RawDatabase | Database,
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

  // Only a scope that serves THIS database may be joined, and only such a
  // scope may lend its tenant id: a tenant id names rows in a particular
  // database, so inheriting one across databases is the same defect wearing a
  // different hat. A foreign scope is simply not ours — we open our own below,
  // and with no tenant to inherit the guard refuses rather than guessing.
  const existingScope = activeScopeForDatabase(db);
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
  rootDb: RawDatabase | Database,
  tenantId: TenantID | string | undefined,
  transactionActive: boolean,
  callbacks: TenantCommitCallbacks,
  work: (db: TenantScopedDatabase) => Promise<T>
): Promise<T> {
  return tenantDatabaseScope.run(
    {
      db: scopedDb,
      rootDb,
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
  const { existingScope, effectiveTenantId } = resolveTenantBoundary(db, tenantId, 'scope');
  // Refusing tenant work under a system scope is about the KIND of work in
  // flight, not about which database it touches, so it reads the ambient store
  // rather than the fenced one. Joining below is routing, and is fenced.
  const ambientScope = tenantDatabaseScope.getStore();
  if (ambientScope?.kind === 'system' && effectiveTenantId) {
    throw new Error(
      `Cannot enter tenant scope ${effectiveTenantId} from active system database scope (${ambientScope.systemReason})`
    );
  }
  if (existingScope) return work(existingScope.db as TenantScopedDatabase);

  const baseDb = databaseRootHandle(db);
  const callbacks = createTenantCommitCallbacks();

  if (!isPostgresDatabase(baseDb) || !effectiveTenantId) {
    const result = await enterOwnedTenantDatabaseScope(
      baseDb,
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
    return enterOwnedTenantDatabaseScope(
      scopedDb,
      baseDb,
      effectiveTenantId,
      true,
      callbacks,
      work
    );
  });
  await drainTenantCommitCallbacks(baseDb, effectiveTenantId, callbacks);
  return result;
}

/**
 * Run one short tenant-owned metadata unit in a native database transaction on
 * both supported dialects.
 *
 * Normal SQLite request scopes are intentionally NON-TRANSACTIONAL (they carry
 * tenant identity and a scope, but no native transaction) because a whole
 * Feathers request can include slow network/process work. Callers use this
 * narrower primitive for metadata phases that must commit atomically. If a
 * PostgreSQL request already owns a transaction, the work joins it. Queued
 * realtime/deferred callbacks drain only after the native transaction commits.
 */
export async function runWithTenantDatabaseTransaction<T>(
  db: TenantScopeAwareDatabase | RawDatabase | Database,
  tenantId: TenantID | string | undefined,
  work: (db: TenantScopedDatabase) => Promise<T>,
  options: { postgresIsolationLevel?: 'repeatable read' | 'serializable' } = {}
): Promise<T> {
  const { existingScope, effectiveTenantId } = resolveTenantBoundary(db, tenantId, 'transaction');
  // Refusing a tenant transaction under a system scope is about the KIND of
  // work in flight, not about which database it touches, so this one reads the
  // ambient store rather than the fenced one.
  const ambientScope = tenantDatabaseScope.getStore();
  if (ambientScope?.kind === 'system') {
    if (effectiveTenantId) {
      throw new Error(
        `Cannot enter tenant transaction ${effectiveTenantId} from active system database scope (${ambientScope.systemReason})`
      );
    }
    throw new Error('Cannot enter a tenant transaction from an active system database scope');
  }
  if (existingScope?.kind === 'tenant' && existingScope.transactionActive) {
    return work(existingScope.db as TenantScopedDatabase);
  }

  const baseDb = databaseRootHandle(db);
  const callbacks = createTenantCommitCallbacks();
  const execute = () =>
    runDatabaseTransaction(
      baseDb,
      async (tx) => {
        await configurePostgresTenantScope(tx, baseDb, effectiveTenantId);
        return enterOwnedTenantDatabaseScope(tx, baseDb, effectiveTenantId, true, callbacks, work);
      },
      { sqliteImmediate: true, postgresIsolationLevel: options.postgresIsolationLevel }
    );

  // SQLite requests normally have a non-transactional DB scope. Temporarily
  // leave it so the repository proxy targets the new native transaction handle.
  // Leave ANY ambient scope, ours or another database's: `execute` opens its
  // own, and nothing in it should inherit a handle it did not ask for.
  const result = ambientScope ? await runWithoutTenantDatabaseScope(execute) : await execute();
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
  // A tenant scope anywhere above forbids system work regardless of which
  // database it belongs to — that refusal is about the kind of work, not about
  // routing — so it reads the ambient store.
  const ambientScope = tenantDatabaseScope.getStore();
  if (ambientScope?.kind === 'tenant') {
    throw new Error(
      `Cannot enter system database scope (${reason}) from active tenant scope ${ambientScope.tenantId}`
    );
  }
  // Joining, by contrast, is routing: only a system scope opened on THIS
  // database may answer for it.
  const existingScope = activeScopeForDatabase(db);
  if (existingScope?.kind === 'system') {
    if (existingScope.systemCapability !== options.capability) {
      throw new Error(
        `Cannot change system database capability from ${existingScope.systemCapability ?? 'none'} to ${options.capability ?? 'none'} (${reason})`
      );
    }
    return work(existingScope.db as SystemDatabase);
  }

  const baseDb = databaseRootHandle(db);
  const scope = (scopedDb: Database) =>
    tenantDatabaseScope.run(
      {
        db: scopedDb,
        rootDb: baseDb,
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
