import { AsyncLocalStorage } from 'node:async_hooks';
import type { TenantID } from '../types/tenant';
import type { Database } from './client';

export interface TenantDatabaseScope {
  db: Database;
  kind: 'tenant' | 'system';
  tenantId?: TenantID | string;
  systemReason?: string;
  postCommitCallbacks?: Array<() => Promise<void>>;
}

export const tenantDatabaseScope = new AsyncLocalStorage<TenantDatabaseScope>();

export function getCurrentTenantDatabase(): Database | undefined {
  return tenantDatabaseScope.getStore()?.db;
}

export function getCurrentTenantId(): TenantID | string | undefined {
  const store = tenantDatabaseScope.getStore();
  return store?.kind === 'tenant' ? store.tenantId : undefined;
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
