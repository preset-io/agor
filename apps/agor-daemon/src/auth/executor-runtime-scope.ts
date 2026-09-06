import { createHash } from 'node:crypto';
import { Forbidden } from '@agor/core/feathers';
import type { AuthenticatedParams, HookContext, Params } from '@agor/core/types';
import { getAuthenticatedConnectionAuthority } from './authenticated-connection-authority.js';
import {
  type EnvironmentLifecycleExecutorAction,
  parseEnvironmentLifecycleExecutorCommandId,
} from './executor-command-ids.js';
import {
  EXECUTOR_COMMAND_TOKEN_PURPOSE,
  EXECUTOR_SESSION_TOKEN_PURPOSE,
  EXECUTOR_SESSION_TOKEN_TYPE,
  type ExecutorSessionTokenPayload,
  type ExecutorTokenPurpose,
  getExecutorSessionTokenSessionId,
  isExecutorSessionTokenPayload,
} from './executor-session-token.js';

/**
 * Executor credentials delegate the initiating user's ordinary Feathers
 * identity and RBAC; this module is not an endpoint allowlist. Keep exact
 * scope checks here only for capabilities a normal user connection does not
 * possess (task lifecycle/data-plane writes, secret resolution, and bounded
 * executor callbacks).
 */

interface ExecutorDelegationContext {
  sessionId?: string;
  taskId?: string;
  branchId?: string;
}

interface AuthenticatedExecutorDelegationContext extends ExecutorDelegationContext {
  purpose: ExecutorTokenPurpose;
}

export interface TaskExecutorRuntimeScope extends ExecutorDelegationContext {
  sessionId: string;
  taskId: string;
}

export interface ExecutorCommandRuntimeScope {
  commandId: string;
  branchId?: string;
}

export interface EnvironmentExecutorCallbackRuntimeScope {
  action: EnvironmentLifecycleExecutorAction;
  generation: number;
  branchId: string;
}

/** Immutable Task credential authority needed by runtime-heartbeat revalidation. */
export interface AuthenticatedTaskExecutorRuntimeAuthority {
  tenantId: string;
  userId: string;
  tokenFingerprint: string;
  sessionId: string;
  taskId: string;
  branchId: string;
}

/**
 * Project executor delegation context only from Feathers' verified JWT payload.
 *
 * The immutable Socket.IO authentication projection and REST authentication
 * hook both preserve this payload. Transport fields and caller-submitted raw
 * bearers are never fallback authority.
 */
function authenticatedExecutorDelegationContext(
  params?: Params
): AuthenticatedExecutorDelegationContext | null {
  const authenticated = params as AuthenticatedParams | undefined;
  if (authenticated?.authentication?.strategy !== 'jwt') return null;
  const payload = authenticated.authentication.payload as ExecutorSessionTokenPayload | undefined;
  if (payload?.type === EXECUTOR_SESSION_TOKEN_TYPE) {
    if (!isExecutorSessionTokenPayload(payload)) {
      throw new Forbidden('Executor token is not valid for this request');
    }
    return {
      purpose: payload.purpose,
      sessionId: getExecutorSessionTokenSessionId(payload),
      taskId: payload.task_id,
      branchId: payload.branch_id,
    };
  }
  return null;
}

/**
 * Verified context for capabilities that only a live task executor receives.
 *
 * Short-lived branch/environment command executors use the same delegated-user
 * authentication family but intentionally carry no task claim. They therefore
 * cannot satisfy task lifecycle, secret, permission, or streaming boundaries.
 */
export function authenticatedTaskExecutorRuntimeScope(
  params?: Params
): TaskExecutorRuntimeScope | null {
  const scope = authenticatedExecutorDelegationContext(params);
  return scope?.purpose === EXECUTOR_SESSION_TOKEN_PURPOSE && scope.taskId && scope.sessionId
    ? { sessionId: scope.sessionId, taskId: scope.taskId, branchId: scope.branchId }
    : null;
}

/**
 * Project the exact already-authenticated Task bearer scope for a heartbeat.
 *
 * Socket.IO uses its private immutable connection authority because the raw
 * token is intentionally discarded after admission. REST hashes the bearer
 * that the JWT authentication hook already verified. Resource and identity
 * fields always come from that verified JWT, never request data.
 */
export function authenticatedTaskExecutorRuntimeAuthority(
  params?: Params
): AuthenticatedTaskExecutorRuntimeAuthority | null {
  const authenticated = params as AuthenticatedParams | undefined;
  const scope = authenticatedTaskExecutorRuntimeScope(params);
  const payload = authenticated?.authentication?.payload as ExecutorSessionTokenPayload | undefined;
  if (
    !scope?.branchId ||
    !payload ||
    typeof payload.sub !== 'string' ||
    !payload.sub ||
    typeof payload.tenant_id !== 'string' ||
    !payload.tenant_id ||
    authenticated?.tenant?.tenant_id !== payload.tenant_id
  ) {
    return null;
  }

  const connectionAuthority = getAuthenticatedConnectionAuthority(params?.connection);
  let tokenFingerprint: string;
  if (connectionAuthority) {
    if (
      connectionAuthority.principal.kind !== 'executor' ||
      connectionAuthority.principal.taskId !== scope.taskId ||
      connectionAuthority.tenant?.tenant_id !== payload.tenant_id
    ) {
      return null;
    }
    tokenFingerprint = connectionAuthority.principal.tokenFingerprint;
  } else {
    const accessToken = (authenticated?.authentication as { accessToken?: unknown } | undefined)
      ?.accessToken;
    if (typeof accessToken !== 'string' || !accessToken) return null;
    tokenFingerprint = createHash('sha256').update(accessToken, 'utf8').digest('hex');
  }

  return {
    tenantId: payload.tenant_id,
    userId: payload.sub,
    tokenFingerprint,
    sessionId: scope.sessionId,
    taskId: scope.taskId,
    branchId: scope.branchId,
  };
}

/** Verified taskless executor command authority from the authenticated JWT. */
export function authenticatedExecutorCommandRuntimeScope(
  params?: Params
): ExecutorCommandRuntimeScope | null {
  const scope = authenticatedExecutorDelegationContext(params);
  return scope?.purpose === EXECUTOR_COMMAND_TOKEN_PURPOSE && scope.sessionId && !scope.taskId
    ? {
        commandId: scope.sessionId,
        branchId: scope.branchId,
      }
    : null;
}

/** Exact action/branch check for a one-purpose executor callback. */
export function matchesExecutorCommandRuntimeScope(
  params: Params | undefined,
  commandId: string,
  branchId?: string
): boolean {
  const scope = authenticatedExecutorCommandRuntimeScope(params);
  return !!scope && scope.commandId === commandId && scope.branchId === branchId;
}

/** Attempt-bound authority for one managed-environment lifecycle callback. */
export function authenticatedEnvironmentExecutorCallbackRuntimeScope(
  params?: Params
): EnvironmentExecutorCallbackRuntimeScope | null {
  const scope = authenticatedExecutorCommandRuntimeScope(params);
  if (!scope?.branchId) return null;
  const attempt = parseEnvironmentLifecycleExecutorCommandId(scope.commandId);
  return attempt ? { ...attempt, branchId: scope.branchId } : null;
}

/** Whether this authenticated transport request carries executor scope for one task. */
export function isTaskScopedExecutorRequest(context: HookContext, taskId: string): boolean {
  return authenticatedTaskExecutorRuntimeScope(context.params)?.taskId === taskId;
}

/** Exact task/session attribution check for executor-only data-plane writes. */
export function matchesTaskExecutorRuntimeScope(
  scope: TaskExecutorRuntimeScope | null,
  target: { task_id?: unknown; session_id?: unknown }
): boolean {
  return !!scope && target.task_id === scope.taskId && target.session_id === scope.sessionId;
}

/**
 * The session an executor-session token is scoped to, or undefined when the
 * request carries no executor scope.
 *
 * Callers that exempt executors from a per-session rule use the canonical task
 * context so taskless command credentials cannot acquire the exemption.
 */
export function executorRuntimeScopeSessionId(context: HookContext): string | undefined {
  return authenticatedTaskExecutorRuntimeScope(context.params)?.sessionId;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Task identifier addressed by a Feathers custom method.
 *
 * Feathers currently exposes custom-method data as `context.data`; retain the
 * arguments fallback because installed hook adapters may preserve only the raw
 * method arguments. Both values are server-observed hook state, never trusted
 * authority: the identifier is compared with the verified JWT claim below.
 */
function executorOperationTaskId(context: HookContext): string | undefined {
  const data = asRecord(context.data);
  if (typeof data?.task_id === 'string' && data.task_id) return data.task_id;

  const firstArgument = (
    context as HookContext & {
      arguments?: unknown[];
    }
  ).arguments?.[0];
  const argumentData = asRecord(firstArgument);
  return typeof argumentData?.task_id === 'string' && argumentData.task_id
    ? argumentData.task_id
    : undefined;
}

/**
 * Guard an executor-only custom method with the exact task lease.
 *
 * Ordinary services intentionally use the initiating user's normal
 * authorization. This hook exists only for lifecycle methods that grant
 * authority a normal user connection does not have.
 */
export function requireTaskScopedExecutorRuntimeToken() {
  return async (context: HookContext): Promise<HookContext> => {
    const taskId = executorOperationTaskId(context);
    if (!taskId || !isTaskScopedExecutorRequest(context, taskId)) {
      throw new Forbidden('A token scoped to this executor task is required');
    }
    return context;
  };
}

/** Guard the transport-only managed-environment settlement callback family. */
export function requireEnvironmentExecutorCallbackToken() {
  return async (context: HookContext): Promise<HookContext> => {
    const input =
      asRecord(context.data) ??
      asRecord((context as HookContext & { arguments?: unknown[] }).arguments?.[0]);
    const branchId = input?.branch_id ?? input?.branchId;
    const generation =
      input?.expected_environment_generation ?? input?.expectedEnvironmentGeneration;
    const scope = authenticatedEnvironmentExecutorCallbackRuntimeScope(context.params);
    if (
      typeof branchId !== 'string' ||
      typeof generation !== 'number' ||
      !Number.isSafeInteger(generation) ||
      !scope ||
      scope.branchId !== branchId ||
      scope.generation !== generation
    ) {
      throw new Forbidden('An executor token scoped to this environment callback is required');
    }
    return context;
  };
}
