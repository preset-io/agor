import { AsyncLocalStorage } from 'node:async_hooks';
import type { TenantID } from '../types/tenant';
import type { Database } from './client';

export interface TenantDatabaseScope {
  db: Database;
  tenantId?: TenantID | string;
  postCommitCallbacks?: Array<() => Promise<void>>;
}

export const tenantDatabaseScope = new AsyncLocalStorage<TenantDatabaseScope>();

export function getCurrentTenantDatabase(): Database | undefined {
  return tenantDatabaseScope.getStore()?.db;
}

export function getCurrentTenantId(): TenantID | string | undefined {
  return tenantDatabaseScope.getStore()?.tenantId;
}

export function enqueueTenantDatabasePostCommitCallback(callback: () => Promise<void>): boolean {
  const store = tenantDatabaseScope.getStore();
  if (!store?.postCommitCallbacks) return false;
  store.postCommitCallbacks.push(callback);
  return true;
}
