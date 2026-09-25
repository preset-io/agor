import { AsyncLocalStorage } from 'node:async_hooks';
import type { TenantID } from '../types/tenant';
import type { Database, RawDatabase } from './client';

/**
 * Which database a scope was opened on.
 *
 * The scope stores are the PROCESS's (see `processScopeStore`), so an ambient
 * scope is visible to every guarded proxy in the process — including proxies
 * over other databases. Without this, "is a scope active?" and "is a scope
 * active *for this database*?" were the same question, and the answer to the
 * second was taken from the first: a proxy over database B, asked inside a
 * scope opened for database A, returned A's handle and therefore A's rows.
 *
 * This is the fully unwrapped base handle (`databaseRootHandle` in
 * `tenant-scope.ts`), not the scoped one: on PostgreSQL `db` is a transaction
 * handle that shares no identity with the base a proxy closes over.
 */
export type TenantDatabaseIdentity = RawDatabase | Database;

export interface TenantOwnedDatabaseScope {
  db: Database;
  /** The database this scope may serve. See {@link TenantDatabaseIdentity}. */
  rootDb: TenantDatabaseIdentity;
  kind: 'tenant';
  /** Whether `db` is a native transaction handle rather than an identity-only scope. */
  transactionActive: boolean;
  tenantId?: TenantID | string;
  postCommitCallbacks: Array<() => Promise<void>>;
  afterCommitCallbacks: Array<() => Promise<void> | void>;
}

export interface SystemDatabaseScope {
  db: Database;
  /** The database this scope may serve. See {@link TenantDatabaseIdentity}. */
  rootDb: TenantDatabaseIdentity;
  kind: 'system';
  systemReason: string;
  systemCapability?: SystemDatabaseCapability;
}

export type TenantDatabaseScope = TenantOwnedDatabaseScope | SystemDatabaseScope;

/** Narrow RLS capabilities available to explicit system database work. */
export type SystemDatabaseCapability =
  | 'api_key_host_tenant_discovery'
  | 'environment_health_discovery'
  | 'gateway_listener_discovery'
  | 'discord_message_delivery_discovery'
  | 'knowledge_embedding_discovery'
  | 'scheduler_discovery'
  | 'task_queue_discovery'
  | 'task_runtime_discovery'
  | 'branch_maintenance_discovery'
  | 'executor_token_maintenance'
  | 'mcp_oauth_callback'
  | 'mcp_oauth_maintenance'
  | 'mcp_oauth_client_registration_maintenance'
  | 'codex_device_auth_maintenance'
  | 'claude_oauth_maintenance'
  | 'github_install_state_callback'
  | 'github_install_state_maintenance'
  | 'upload_maintenance';

export interface TenantContextScope {
  tenantId: TenantID | string;
}

/**
 * One scope store per process, not per bundled copy of this module.
 *
 * `@agor/core` ships with `splitting: false`, so every tsup entry point inlines
 * its own copy of this file. `@agor/core/db` and
 * `@agor/core/tools/mcp/oauth-refresh` are separate entries, and the daemon
 * loads both: without this, each would own a private `AsyncLocalStorage`, a
 * scope armed through one would be invisible to a guarded proxy built by the
 * other, and the guard would reject work that had correctly declared its
 * tenant. Keying on `Symbol.for` makes the store the process's, which is what
 * an ambient scope has to be to mean anything.
 */
function processScopeStore<T>(key: string): AsyncLocalStorage<T> {
  const registry = globalThis as typeof globalThis & Record<symbol, unknown>;
  const symbol = Symbol.for(key);
  const existing = registry[symbol];
  if (existing) return existing as AsyncLocalStorage<T>;
  const created = new AsyncLocalStorage<T>();
  registry[symbol] = created;
  return created;
}

/** Long-lived operation identity. This never owns a database transaction. */
export const tenantContextScope = processScopeStore<TenantContextScope>(
  'agor.db.tenant-context-scope'
);
export const tenantDatabaseScope = processScopeStore<TenantDatabaseScope>(
  'agor.db.tenant-database-scope'
);

export function getCurrentTenantDatabase(): Database | undefined {
  return tenantDatabaseScope.getStore()?.db;
}

export function getCurrentTenantId(): TenantID | string | undefined {
  const contextTenantId = tenantContextScope.getStore()?.tenantId;
  if (contextTenantId) return contextTenantId;
  const store = tenantDatabaseScope.getStore();
  return store?.kind === 'tenant' ? store.tenantId : undefined;
}

/**
 * Run an operation with ambient tenant identity but without opening a DB
 * transaction. Short database units of work should independently enter
 * runWithTenantDatabaseScope(), which validates against this identity.
 */
export function runWithTenantContext<T>(tenantId: TenantID | string, work: () => T): T {
  const currentTenantId = tenantContextScope.getStore()?.tenantId;
  if (currentTenantId) {
    if (currentTenantId !== tenantId) {
      throw new Error(
        `Cannot enter tenant context ${tenantId} from active tenant context ${currentTenantId}`
      );
    }
    return work();
  }
  return tenantContextScope.run({ tenantId }, work);
}

/** Explicitly leave operation identity for global/cross-tenant orchestration. */
export function runWithoutTenantContext<T>(work: () => T): T {
  return tenantContextScope.exit(work);
}

export function getCurrentTenantDatabaseScope(): TenantDatabaseScope | undefined {
  return tenantDatabaseScope.getStore();
}

export function requireCurrentTenantId(
  message = 'Missing active tenant context'
): TenantID | string {
  const tenantId = getCurrentTenantId();
  if (!tenantId) throw new Error(message);
  return tenantId;
}

/**
 * Explicitly leave the ambient tenant DB scope for global/system work.
 *
 * Use this for deferred work that must open its own transaction/scope (for
 * example post-response executor/queue fanout). A bare setImmediate/setTimeout
 * inherits AsyncLocalStorage, including transaction objects that may have
 * already committed.
 */
export function runWithoutTenantDatabaseScope<T>(work: () => T): T {
  return tenantDatabaseScope.exit(work);
}

export function enqueueTenantDatabasePostCommitCallback(callback: () => Promise<void>): boolean {
  const store = tenantDatabaseScope.getStore();
  if (store?.kind !== 'tenant') return false;
  store.postCommitCallbacks.push(callback);
  return true;
}

/** Schedule non-DB work after the active transaction commits. */
export function enqueueAfterTenantDatabaseCommit(callback: () => Promise<void> | void): boolean {
  const store = tenantDatabaseScope.getStore();
  if (store?.kind !== 'tenant') return false;
  store.afterCommitCallbacks.push(callback);
  return true;
}
