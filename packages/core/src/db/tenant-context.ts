import { AsyncLocalStorage } from 'node:async_hooks';
import type { TenantID } from '../types/tenant';
import type { Database } from './client';

export interface TenantDatabaseScope {
  db: Database;
  kind: 'tenant' | 'system';
  tenantId?: TenantID | string;
  systemReason?: string;
  systemCapability?: SystemDatabaseCapability;
  postCommitCallbacks?: Array<() => Promise<void>>;
  afterCommitCallbacks?: Array<() => Promise<void> | void>;
}

/** Narrow RLS capabilities available to explicit system database work. */
export type SystemDatabaseCapability = 'gateway_listener_discovery';

export interface TenantContextScope {
  tenantId: TenantID | string;
}

/** Long-lived operation identity. This never owns a database transaction. */
export const tenantContextScope = new AsyncLocalStorage<TenantContextScope>();
export const tenantDatabaseScope = new AsyncLocalStorage<TenantDatabaseScope>();

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
  if (!store?.postCommitCallbacks) return false;
  store.postCommitCallbacks.push(callback);
  return true;
}

/** Schedule non-DB work after the active transaction commits. */
export function enqueueAfterTenantDatabaseCommit(callback: () => Promise<void> | void): boolean {
  const store = tenantDatabaseScope.getStore();
  if (!store?.afterCommitCallbacks) return false;
  store.afterCommitCallbacks.push(callback);
  return true;
}
