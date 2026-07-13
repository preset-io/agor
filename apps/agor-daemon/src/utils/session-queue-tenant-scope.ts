import { type AgorConfig, resolveMultiTenancyConfig } from '@agor/core/config';
import { runWithTenantContext, type TenantScopeAwareDatabase } from '@agor/core/db';
import type { Params, SessionID, TenantContext, TenantID } from '@agor/core/types';
import { deferWithTenantContext, resolveTenantIdForDeferredScope } from './tenant-db-scope.js';

type QueueTenantParams = Params & {
  tenant?: Pick<TenantContext, 'tenant_id' | 'source'>;
};

export interface SessionQueueTenantScopeOptions {
  db: TenantScopeAwareDatabase;
  config: AgorConfig;
  sessionId: SessionID;
  params?: Params;
  /**
   * Trusted tenant id from an already-loaded tenant-owned row (for example a
   * Postgres sessions/tasks patch result). Do not populate this from request
   * payloads or request-less tenant discovery reads.
   */
  tenantIdHint?: string;
  label: string;
}

function staticTenantId(config: AgorConfig): string | undefined {
  const multiTenancy = resolveMultiTenancyConfig(config);
  return multiTenancy.mode === 'static' ? multiTenancy.static_tenant_id : undefined;
}

function trustedTenantIdHint(options: SessionQueueTenantScopeOptions): string | undefined {
  const hint = options.tenantIdHint?.trim();
  return hint || undefined;
}

export function queueTenantParams(
  params: Params | undefined,
  tenantId: string,
  source: TenantContext['source'] = 'explicit'
): QueueTenantParams {
  const currentTenant = (params as QueueTenantParams | undefined)?.tenant;
  // Queue drains are new daemon-owned operations, not continuations of the
  // request that completed the previous task. In particular, executor JWTs
  // are task-scoped: forwarding the completed task's transport/auth params
  // makes secret resolution for the next queued task fail with a task-scope
  // mismatch. Preserve the resolved user and other internal context, but
  // deliberately cross an authentication boundary here.
  const {
    authentication: _authentication,
    connection: _connection,
    provider: _provider,
    headers: _headers,
    ...internalParams
  } = params ?? {};
  return {
    ...internalParams,
    tenant: {
      ...currentTenant,
      tenant_id: tenantId as TenantID,
      source: currentTenant?.source ?? source,
    },
  };
}

export async function runWithSessionQueueTenantScope<T>(
  options: SessionQueueTenantScopeOptions,
  work: (params: QueueTenantParams) => Promise<T>
): Promise<T | undefined> {
  const capturedTenantId = resolveTenantIdForDeferredScope(options.params);

  if (capturedTenantId) {
    const scopedParams = queueTenantParams(options.params, capturedTenantId, 'explicit');
    return runWithTenantContext(capturedTenantId, () => work(scopedParams));
  }

  const tenantIdHint = trustedTenantIdHint(options);
  if (tenantIdHint) {
    const scopedParams = queueTenantParams(options.params, tenantIdHint, 'explicit');
    return runWithTenantContext(tenantIdHint, () => work(scopedParams));
  }

  const configuredStaticTenantId = staticTenantId(options.config);
  if (!configuredStaticTenantId) {
    console.error(
      `❌ [Queue] ${options.label} skipped for session ${options.sessionId}: missing tenant context`
    );
    return undefined;
  }

  const scopedParams = queueTenantParams(options.params, configuredStaticTenantId, 'static');
  return runWithTenantContext(configuredStaticTenantId, () => work(scopedParams));
}

export function deferWithSessionQueueTenantScope(
  options: SessionQueueTenantScopeOptions,
  work: (params: QueueTenantParams) => Promise<void>,
  onError?: (error: unknown) => void
): void {
  const handleError = (error: unknown) => {
    if (onError) {
      onError(error);
      return;
    }
    console.error(`❌ [Queue] ${options.label} failed:`, error);
  };

  const capturedTenantId = resolveTenantIdForDeferredScope(options.params);
  if (capturedTenantId) {
    const scopedParams = queueTenantParams(options.params, capturedTenantId, 'explicit');
    deferWithTenantContext(scopedParams, () => work(scopedParams), handleError);
    return;
  }

  const tenantIdHint = trustedTenantIdHint(options);
  if (tenantIdHint) {
    const scopedParams = queueTenantParams(options.params, tenantIdHint, 'explicit');
    deferWithTenantContext(scopedParams, () => work(scopedParams), handleError);
    return;
  }

  const configuredStaticTenantId = staticTenantId(options.config);
  if (!configuredStaticTenantId) {
    handleError(
      new Error(`${options.label} skipped for session ${options.sessionId}: missing tenant context`)
    );
    return;
  }

  const scopedParams = queueTenantParams(options.params, configuredStaticTenantId, 'static');
  deferWithTenantContext(scopedParams, () => work(scopedParams), handleError);
}
