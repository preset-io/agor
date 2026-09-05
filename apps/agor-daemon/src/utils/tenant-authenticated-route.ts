import type { AgorConfig } from '@agor/core/config';
import type { TenantScopeAwareDatabase } from '@agor/core/db';
import { registerAuthenticatedRoute as registerAuthenticatedRouteUnscoped } from './authorization.js';
import {
  createTenantDatabaseScopeAroundHook,
  createTenantWriteGateAroundHook,
} from './tenant-db-scope.js';

/**
 * Register an authenticated custom route with the same tenant database scope
 * and write-freeze gate as an ordinary tenant-owned Feathers service.
 *
 * Custom-route registrations do not pass through the centralized
 * TENANT_OWNED_SERVICE_PATHS hook inventory. Callers must use this registrar
 * so tenant database scope and write fencing are installed at the route's
 * registration boundary.
 */
export function createTenantScopedAuthenticatedRouteRegistrar(options: {
  db: TenantScopeAwareDatabase;
  config: AgorConfig;
  jwtSecret: string;
}): typeof registerAuthenticatedRouteUnscoped {
  const tenantDatabaseScopeAround = createTenantDatabaseScopeAroundHook(options);
  const tenantWriteGateAround = createTenantWriteGateAroundHook(options.db);
  return (routeApp, path, service, authConfig, routeRequireAuth, routeOptions = {}) =>
    registerAuthenticatedRouteUnscoped(routeApp, path, service, authConfig, routeRequireAuth, {
      ...routeOptions,
      around: [tenantDatabaseScopeAround, tenantWriteGateAround, ...(routeOptions.around ?? [])],
    });
}
