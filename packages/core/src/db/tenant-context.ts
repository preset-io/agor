import { AsyncLocalStorage } from 'node:async_hooks';
import type { TenantID } from '../types/tenant';
import type { Database } from './client';

export interface TenantDatabaseScope {
  db: Database;
  tenantId?: TenantID | string;
}

export const tenantDatabaseScope = new AsyncLocalStorage<TenantDatabaseScope>();

export function getCurrentTenantDatabase(): Database | undefined {
  return tenantDatabaseScope.getStore()?.db;
}

export function getCurrentTenantId(): TenantID | string | undefined {
  return tenantDatabaseScope.getStore()?.tenantId;
}
