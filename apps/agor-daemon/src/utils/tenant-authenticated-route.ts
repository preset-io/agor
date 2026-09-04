import type { AgorConfig } from '@agor/core/config';
import type { TenantScopeAwareDatabase } from '@agor/core/db';
import { registerAuthenticatedRoute as registerAuthenticatedRouteBase } from './authorization.js';
import {
  createTenantDatabaseScopeAroundHook,
  createTenantWriteGateAroundHook,
} from './tenant-db-scope.js';

/**
 * Register an authenticated custom route with the same tenant database scope
 * and write-freeze gate as an ordinary tenant-owned Feathers service.
 *
 * Custom routes are not necessarily present when the static tenant-owned
 * service hook list is installed, so this registrar is their authoritative
 * database boundary.
 */
export function createTenantScopedAuthenticatedRouteRegistrar(options: {
  db: TenantScopeAwareDatabase;
  config: AgorConfig;
  jwtSecret: string;
}): typeof registerAuthenticatedRouteBase {
  const tenantDatabaseScopeAround = createTenantDatabaseScopeAroundHook(options);
  const tenantWriteGateAround = createTenantWriteGateAroundHook(options.db);
  return (routeApp, path, service, authConfig, routeRequireAuth, routeOptions = {}) =>
    registerAuthenticatedRouteBase(routeApp, path, service, authConfig, routeRequireAuth, {
      ...routeOptions,
      around: [tenantDatabaseScopeAround, tenantWriteGateAround, ...(routeOptions.around ?? [])],
    });
}
