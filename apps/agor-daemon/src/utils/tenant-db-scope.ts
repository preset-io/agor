import {
  type AgorConfig,
  resolveMultiTenancyConfig,
  resolveTenantContext,
  TenantResolutionError,
} from '@agor/core/config';
import {
  enqueueTenantDatabasePostCommitCallback,
  getCurrentTenantId,
  runWithoutTenantDatabaseScope,
  runWithTenantDatabaseScope,
  type TenantScopeAwareDatabase,
} from '@agor/core/db';
import { NotAuthenticated } from '@agor/core/feathers';
import type { HookContext, TenantContext, TenantID } from '@agor/core/types';
import jwt from 'jsonwebtoken';
import { RUNTIME_JWT_AUDIENCE, RUNTIME_JWT_ISSUER } from '../auth/runtime-tokens.js';

interface TenantDatabaseScopeOptions {
  db: TenantScopeAwareDatabase;
  config: AgorConfig;
  jwtSecret: string;
}

function readHeaderValue(
  headers: Record<string, unknown> | undefined,
  name: string
): string | null {
  if (!headers) return null;
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== wanted) continue;
    const raw = Array.isArray(value) ? value[0] : value;
    return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
  }
  return null;
}

type TenantScopedParams = { tenant?: Pick<TenantContext, 'tenant_id'> } | undefined;

export function resolveTenantIdForDeferredScope(params?: unknown): string | undefined {
  const scopedParams = params as TenantScopedParams;
  return scopedParams?.tenant?.tenant_id ?? getCurrentTenantId();
}

/**
 * Schedule asynchronous work outside the current ALS store, then re-enter a
 * fresh tenant database scope for the captured tenant. Use this for delayed
 * executor/queue/gateway work: bare setImmediate inherits possibly-committed
 * transaction objects, but a bare runWithoutTenantDatabaseScope loses Postgres
 * RLS context entirely.
 */
export function deferWithTenantDatabaseScope(
  db: TenantScopeAwareDatabase,
  params: unknown,
  work: () => Promise<void>,
  onError?: (error: unknown) => void
): void {
  const tenantId = resolveTenantIdForDeferredScope(params);
  if (!tenantId) {
    const error = new Error('Missing tenant context for deferred tenant-scoped work');
    if (onError) {
      onError(error);
    } else {
      console.error('[tenant-db-scope] Deferred tenant-scoped work skipped:', error);
    }
    return;
  }

  const schedule = () => {
    runWithoutTenantDatabaseScope(() => {
      setImmediate(() => {
        void runWithTenantDatabaseScope(db, tenantId, work).catch((error) => {
          if (onError) {
            onError(error);
            return;
          }
          console.error('[tenant-db-scope] Deferred tenant-scoped work failed:', error);
        });
      });
    });
  };

  // If the caller is inside a tenant DB transaction, wait until the
  // transaction commits before opening the fresh scope. Otherwise executor
  // startup can race ahead and read rows (sessions/tasks/messages) that are
  // still invisible on its new connection.
  if (enqueueTenantDatabasePostCommitCallback(async () => schedule())) {
    return;
  }

  schedule();
}

export function createTenantDatabaseScopeAroundHook(options: TenantDatabaseScopeOptions) {
  const multiTenancy = resolveMultiTenancyConfig(options.config);

  const bearerPayloadFromHeaders = (headers: Record<string, unknown> | undefined): unknown => {
    const authorization = readHeaderValue(headers, 'authorization');
    const match = authorization?.match(/^Bearer\s+(.+)$/i);
    if (!match || !options.jwtSecret) return undefined;
    try {
      return jwt.verify(match[1], options.jwtSecret, {
        issuer: RUNTIME_JWT_ISSUER,
        audience: RUNTIME_JWT_AUDIENCE,
      });
    } catch {
      // Let the normal Feathers auth hook return the canonical auth failure.
      return undefined;
    }
  };

  const resolveTenantForDatabaseScope = (context: HookContext) => {
    const params = context.params as HookContext['params'] & {
      headers?: Record<string, unknown>;
      connection?: { tenant?: unknown; data?: { tenant?: unknown } };
    };
    const connectionTenant = params.connection?.tenant ?? params.connection?.data?.tenant;
    const paramsWithConnectionTenant =
      connectionTenant && typeof connectionTenant === 'object' && 'tenant_id' in connectionTenant
        ? ({ ...params, tenant: params.tenant ?? connectionTenant } as typeof params)
        : params;

    try {
      // Resolve explicit/auth/socket tenant context first, even for internal
      // calls. If this is nested inside a different active tenant scope,
      // runWithTenantDatabaseScope below will reject the cross-tenant switch
      // instead of silently inheriting or switching.
      return resolveTenantContext(multiTenancy, {
        params: paramsWithConnectionTenant,
        authPayload:
          paramsWithConnectionTenant.authentication?.payload ??
          bearerPayloadFromHeaders(paramsWithConnectionTenant.headers),
        headers: paramsWithConnectionTenant.headers,
      });
    } catch (error) {
      const inheritedTenantId = getCurrentTenantId();
      if (error instanceof TenantResolutionError && inheritedTenantId) {
        return { tenant_id: inheritedTenantId as TenantID, source: 'explicit' as const };
      }
      throw error;
    }
  };

  return async (context: HookContext, next: () => Promise<void>): Promise<void> => {
    try {
      context.params.tenant = resolveTenantForDatabaseScope(context);
    } catch (error) {
      if (error instanceof TenantResolutionError) {
        throw new NotAuthenticated(error.message);
      }
      throw error;
    }

    await runWithTenantDatabaseScope(options.db, context.params.tenant?.tenant_id, next);
  };
}
