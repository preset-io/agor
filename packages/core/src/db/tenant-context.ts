import { AsyncLocalStorage } from 'node:async_hooks';
import type { TenantID } from '../types/tenant';
import type { Database } from './client';

export type TenantDatabasePostCommitCallback = (() => Promise<void>) & {
  runOutsideTenantScope?: boolean;
};

export interface TenantDatabaseScope {
  db: Database;
  tenantId?: TenantID | string;
  postCommitCallbacks?: TenantDatabasePostCommitCallback[];
}

export const tenantDatabaseScope = new AsyncLocalStorage<TenantDatabaseScope>();

export function getCurrentTenantDatabase(): Database | undefined {
  return tenantDatabaseScope.getStore()?.db;
}

export function getCurrentTenantId(): TenantID | string | undefined {
  return tenantDatabaseScope.getStore()?.tenantId;
}

export function enqueueTenantDatabasePostCommitCallback(
  callback: TenantDatabasePostCommitCallback
): boolean {
  const store = tenantDatabaseScope.getStore();
  if (!store?.postCommitCallbacks) return false;
  store.postCommitCallbacks.push(callback);
  return true;
}
