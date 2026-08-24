import {
  type AgorConfig,
  resolveMultiTenancyConfig,
  resolveTenantContext,
  TenantResolutionError,
} from '@agor/core/config';
import {
  assertTenantWritable,
  enqueueAfterTenantDatabaseCommit,
  enqueueTenantDatabasePostCommitCallback,
  getCurrentTenantDatabaseScope,
  getCurrentTenantId,
  isTenantWriteMethodName,
  runWithoutTenantDatabaseScope,
  runWithTenantContext,
  runWithTenantDatabaseScope,
  type TenantScopeAwareDatabase,
  TenantWriteGateActiveError,
} from '@agor/core/db';
import { NotAuthenticated, Unavailable } from '@agor/core/feathers';
import type { HookContext, TenantContext, TenantID } from '@agor/core/types';
import jwt from 'jsonwebtoken';
import { RUNTIME_JWT_AUDIENCE, RUNTIME_JWT_ISSUER } from '../auth/runtime-tokens.js';

interface TenantDatabaseScopeOptions {
  db: TenantScopeAwareDatabase;
  config: AgorConfig;
  jwtSecret: string;
  /** Identity-only boundary for long custom operations with explicit DB units. */
  transaction?: boolean;
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

/**
 * Enforce the tenant freeze gate inside an already-open tenant transaction.
 * Shared by ordinary Feathers services and custom authenticated routes so a
 * route registered after `registerHooks()` cannot silently miss the gate.
 */
export async function enforceTenantWriteGateForHook(
  db: TenantScopeAwareDatabase,
  context: HookContext
): Promise<HookContext> {
  if (!isTenantWriteMethodName(context.method)) return context;
  const tenantId = context.params.tenant?.tenant_id;
  if (!tenantId || !getCurrentTenantDatabaseScope()) return context;
  try {
    await assertTenantWritable(db, tenantId);
  } catch (error) {
    if (error instanceof TenantWriteGateActiveError) {
      throw new Unavailable(error.message);
    }
    throw error;
  }
  return context;
}

/** Around-hook adapter for custom routes whose inner handler performs writes. */
export function createTenantWriteGateAroundHook(db: TenantScopeAwareDatabase) {
  return async (context: HookContext, next: () => Promise<void>): Promise<void> => {
    await enforceTenantWriteGateForHook(db, context);
    await next();
  };
}

/**
 * Admission-only write-gate check for authenticated routes that perform long
 * process/network orchestration.
 *
 * Unlike {@link createTenantWriteGateAroundHook}, this helper does not expect
 * the route to retain a database transaction while `next()` runs. It opens one
 * short tenant write unit, checks the gate, commits it, and only then enters
 * the long handler. Repository/service writes inside the handler retain their
 * own gate checks; this admission check prevents external side effects from
 * starting while a tenant freeze is already active.
 */
export function createTenantWriteAdmissionAroundHook(db: TenantScopeAwareDatabase) {
  return async (context: HookContext, next: () => Promise<void>): Promise<void> => {
    if (isTenantWriteMethodName(context.method)) {
      const tenantId = context.params.tenant?.tenant_id ?? getCurrentTenantId();
      if (tenantId) {
        try {
          await assertTenantWriteAdmission(db, tenantId);
        } catch (error) {
          if (error instanceof TenantWriteGateActiveError) {
            throw new Unavailable(error.message);
          }
          throw error;
        }
      }
    }
    await next();
  };
}

export function resolveTenantIdForDeferredScope(params?: unknown): string | undefined {
  const scopedParams = params as TenantScopedParams;
  return scopedParams?.tenant?.tenant_id ?? getCurrentTenantId();
}

/**
 * Run one mutation boundary used by long-lived tenant orchestration.
 *
 * Executor callbacks and termination coordinators can outlive the request
 * transaction that created them. AsyncLocalStorage propagates that transaction
 * object into callbacks, so merely calling runWithTenantDatabaseScope would
 * rejoin a possibly committed scope. Always leave any inherited DB scope, open
 * one new short tenant transaction, and enforce the write gate inside it.
 */
export function withFreshTenantWrite<T>(
  db: TenantScopeAwareDatabase,
  tenantId: string | undefined,
  work: () => Promise<T>
): Promise<T> {
  if (!tenantId) {
    throw new Error('Missing tenant context for tenant-scoped mutation');
  }
  return runWithoutTenantDatabaseScope(() =>
    runWithTenantDatabaseScope(db, tenantId, async (scoped) => {
      await assertTenantWritable(scoped, tenantId);
      return work();
    })
  );
}

/** Assert write admission in one fresh, short tenant database unit. */
export function assertTenantWriteAdmission(
  db: TenantScopeAwareDatabase,
  tenantId: string | undefined
): Promise<void> {
  return withFreshTenantWrite(db, tenantId, async () => undefined);
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
        // Deferred tenant writer: fail closed at the write gate (see
        // assertTenantWritable) inside the fresh transaction before the work.
        void withFreshTenantWrite(db, tenantId, work).catch((error) => {
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

/** Defer long orchestration work after commit with tenant identity only. */
export function deferWithTenantContext(
  params: unknown,
  work: () => Promise<void>,
  onError?: (error: unknown) => void
): void {
  const tenantId = resolveTenantIdForDeferredScope(params);
  if (!tenantId) {
    onError?.(new Error('Missing tenant context for deferred work'));
    return;
  }
  const schedule = () => {
    runWithoutTenantDatabaseScope(() => {
      setImmediate(() => {
        void runWithTenantContext(tenantId, work).catch((error) =>
          onError ? onError(error) : console.error('[tenant-context] Deferred work failed:', error)
        );
      });
    });
  };
  if (!enqueueAfterTenantDatabaseCommit(schedule)) schedule();
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

    const tenantId = context.params.tenant?.tenant_id;
    if (!tenantId) {
      await runWithTenantDatabaseScope(options.db, tenantId, next);
      return;
    }
    await runWithTenantContext(tenantId, () =>
      options.transaction === false
        ? next()
        : runWithTenantDatabaseScope(options.db, tenantId, next)
    );
  };
}
