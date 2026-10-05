/**
 * The shared `requireAuth` hook factory — the single REST/Feathers auth
 * chokepoint. Composes the authentication strategy hook, the terminal-executor
 * rejection guard, and tenant resolution. Extracted from index.ts so the
 * composition (specifically that the terminal-executor guard is wired in) is
 * unit-testable and can't be silently dropped by a refactor.
 */

import {
  type ResolvedMultiTenancyConfig,
  resolveTenantContext,
  TenantResolutionError,
} from '@agor/core/config';
import { NotAuthenticated } from '@agor/core/feathers';
import type { HookContext } from '@agor/core/types';
import { setLogContextField } from '@agor/core/utils/log-context';
import { authenticatedTaskExecutorRuntimeScope } from './executor-runtime-scope.js';
import { endTenantRestrictionRequest, withTenantRestrictionRequest } from './tenant-access.js';
import { rejectTerminalExecutorIdentity } from './terminal-executor-guard.js';

export type AuthHook = (context: HookContext) => Promise<HookContext>;

/**
 * Log context only, never authority. JWT, personal API keys and Socket.IO all
 * resolve to `params.user`; an executor session token also carries its
 * verified session/task/branch. No-op outside the around hook's log scope.
 */
function stampAuthenticatedLogContext(authed: HookContext): void {
  setLogContextField('user_id', authed.params.user?.user_id);
  let executor: ReturnType<typeof authenticatedTaskExecutorRuntimeScope> = null;
  try {
    executor = authenticatedTaskExecutorRuntimeScope(authed.params);
  } catch {
    // An invalid executor token is rejected by the boundaries that need it.
    return;
  }
  if (!executor) return;
  setLogContextField('session_id', executor.sessionId);
  setLogContextField('task_id', executor.taskId);
  setLogContextField('branch_id', executor.branchId);
}

export function createRequireAuthHook(
  authenticatedHook: AuthHook,
  multiTenancy: ResolvedMultiTenancyConfig
): AuthHook {
  return async (context: HookContext): Promise<HookContext> => {
    const authed = await authenticatedHook(context);
    stampAuthenticatedLogContext(authed);
    // A terminal-executor identity is valid ONLY for the Socket.IO terminal
    // channel (handled outside Feathers); reject it from every REST/Feathers
    // service call here so it can't ride the RBAC rank table's viewer-rank
    // fallthrough into API access.
    await rejectTerminalExecutorIdentity(authed);
    try {
      authed.params.tenant = resolveTenantContext(multiTenancy, { params: authed.params });
      return authed;
    } catch (error) {
      if (error instanceof TenantResolutionError) {
        throw new NotAuthenticated(error.message);
      }
      throw error;
    }
  };
}

/** Tenant admission after authentication; safety traffic is authorized by the callback, never a provider/role/flag exemption. */
export function createTenantRestrictedAuthHook(
  authenticatedHook: AuthHook,
  multiTenancy: ResolvedMultiTenancyConfig,
  assertTenantAccess: (tenantId: string, context: HookContext) => Promise<void>
): AuthHook {
  const identity = createRequireAuthHook(authenticatedHook, multiTenancy);
  // Strategy and hook share the packet's (or this request's) single restriction read.
  return (context) =>
    withTenantRestrictionRequest(async () => {
      try {
        const authed = await identity(context);
        await assertTenantAccess(authed.params.tenant!.tenant_id, authed);
        return authed;
      } finally {
        endTenantRestrictionRequest();
      }
    }, true);
}
