import type { ResolvedMultiTenancyConfig } from '@agor/core/config';
import { NotAuthenticated } from '@agor/core/feathers';
import type { AuthenticatedUser, TenantContext } from '@agor/core/types';
import {
  type ExecutorConnectionRevocationFence,
  getExecutorConnectionCandidate,
} from './executor-connection-admission.js';
import { isExecutorSessionTokenPayload } from './executor-session-token.js';
import { resolveSignedRuntimeTenant } from './runtime-tokens.js';
import { isTerminalExecutorIdentity } from './terminal-executor-guard.js';
import { redactUserAuthMetadata } from './user-redaction.js';

const CONNECTION_AUTHORITY = Symbol('agor.authenticated-connection-authority');
const CONNECTION_AUTHORITY_BOUND = Symbol('agor.authenticated-connection-authority-bound');

interface AuthenticatedConnection {
  authenticated?: boolean;
  authentication?: Readonly<{ strategy: string; payload?: Readonly<Record<string, unknown>> }>;
  tenant?: TenantContext;
  user?: Readonly<AuthenticatedUser>;
}

interface AuthenticationResultShape {
  user?: AuthenticatedUser;
  authentication?: { strategy?: unknown; payload?: unknown };
}

type AuthorityCarrier = {
  [CONNECTION_AUTHORITY]?: AuthenticatedConnectionAuthority;
  [CONNECTION_AUTHORITY_BOUND]?: true;
};

export type AuthenticatedConnectionPrincipal =
  | { kind: 'user'; userId: string }
  | { kind: 'service' }
  | {
      kind: 'terminal-executor';
      terminalUserId: string;
      terminalId: string;
      branchId: string;
      ownerBootId: string;
    }
  | {
      kind: 'executor';
      taskId?: string;
      tokenFingerprint: string;
      revocationGeneration: number;
    }
  | {
      kind: 'executor-completion-receipt';
      taskId: string;
      sessionId: string;
      resultMessageId: string;
      tokenFingerprint: string;
    };

/**
 * Immutable authority established before Socket.IO accepts a connection.
 *
 * This is deliberately connection-owned rather than authentication-result-
 * owned. A Socket.IO transport may reconnect, but one accepted namespace
 * connection has exactly one verified principal and tenant for its lifetime.
 * Refreshing a token or changing identity therefore requires a new handshake.
 */
export interface AuthenticatedConnectionAuthority {
  readonly principal: AuthenticatedConnectionPrincipal;
  readonly tenant?: TenantContext;
  /** Absolute expiry of the bearer accepted at the namespace handshake. */
  readonly expiresAt?: number;
  /** Whether this connection capability itself must be retired at `expiresAt`. */
  readonly retireAtExpiry: boolean;
}

export interface FinalizeAuthenticatedConnectionOptions {
  connection: object;
  authResult: object;
  multiTenancy?: ResolvedMultiTenancyConfig;
  executorRevocationFence?: ExecutorConnectionRevocationFence;
}

function asNotAuthenticated(error: unknown): NotAuthenticated {
  return error instanceof NotAuthenticated
    ? error
    : new NotAuthenticated(
        error instanceof Error ? error.message : 'Authenticated tenant authority is invalid'
      );
}

function defineConnectionProjection(connection: object, key: string, value: unknown): void {
  Object.defineProperty(connection, key, {
    configurable: true,
    enumerable: true,
    writable: false,
    value,
  });
}

/**
 * Project the already-verified handshake identity into Feathers service params.
 *
 * Socket.IO copies enumerable connection properties into every service call.
 * Marking that projection authenticated lets the shared authentication hook
 * consume the immutable server-owned result instead of re-verifying a bearer
 * on every request. Raw bearer material is deliberately not retained.
 */
function bindAuthenticatedFeathersProjection(
  connection: object,
  result: AuthenticationResultShape,
  tenant: TenantContext | undefined
): void {
  const user = result.user;
  const strategy = result.authentication?.strategy;
  if (!user || typeof strategy !== 'string' || !strategy) {
    throw new NotAuthenticated('Authenticated Feathers projection is unavailable');
  }
  const payload = result.authentication?.payload;
  const frozenPayload =
    payload && typeof payload === 'object'
      ? Object.freeze({ ...(payload as Record<string, unknown>) })
      : undefined;
  const authentication = Object.freeze({
    strategy,
    ...(frozenPayload ? { payload: frozenPayload } : {}),
  });

  defineConnectionProjection(connection, 'authenticated', true);
  defineConnectionProjection(connection, 'authentication', authentication);
  defineConnectionProjection(
    connection,
    'user',
    Object.freeze({ ...redactUserAuthMetadata(user) })
  );
  if (tenant) defineConnectionProjection(connection, 'tenant', tenant);
}

/**
 * Synchronously commit the verified authority for a newly authenticated
 * connection. Calling this twice is always an authentication failure, even
 * when the second token names the same user and tenant: live identity/token
 * replacement is not part of the connection contract.
 */
export function finalizeAuthenticatedConnectionAuthority(
  options: FinalizeAuthenticatedConnectionOptions
): AuthenticatedConnectionAuthority {
  const { connection, authResult, multiTenancy, executorRevocationFence } = options;
  if ((connection as AuthorityCarrier)[CONNECTION_AUTHORITY_BOUND]) {
    throw new NotAuthenticated('Socket connection authentication is immutable');
  }

  const result = authResult as AuthenticationResultShape;
  const payload = result.authentication?.payload;
  const expiresAt =
    payload &&
    typeof payload === 'object' &&
    typeof (payload as { exp?: unknown }).exp === 'number' &&
    Number.isFinite((payload as { exp: number }).exp)
      ? (payload as { exp: number }).exp * 1000
      : undefined;

  let tenant: TenantContext | undefined;
  try {
    tenant = resolveSignedRuntimeTenant(multiTenancy, payload);
  } catch (error) {
    throw asNotAuthenticated(error);
  }
  const trustedTenant = tenant ? Object.freeze({ ...tenant }) : undefined;

  const executorCandidate = getExecutorConnectionCandidate(authResult);
  const completionReceipt = executorCandidate?.completionReceipt;
  const isExecutorLogin = Boolean(executorCandidate) || isExecutorSessionTokenPayload(payload);
  if (isExecutorLogin) {
    if (!executorCandidate || !trustedTenant || !executorRevocationFence) {
      throw new NotAuthenticated('Executor connection authority is unavailable');
    }
    if (executorCandidate.tenantId !== trustedTenant.tenant_id) {
      throw new NotAuthenticated('Executor connection authority was revoked');
    }
    if (
      !completionReceipt &&
      !executorRevocationFence.isCurrent(
        executorCandidate.tenantId,
        executorCandidate.revocationGeneration
      )
    ) {
      throw new NotAuthenticated('Executor connection authority was revoked');
    }
  }

  const user = result.user;
  let principal: AuthenticatedConnectionPrincipal;
  if (completionReceipt) {
    if (
      !executorCandidate ||
      completionReceipt.taskId !== executorCandidate.taskId ||
      completionReceipt.sessionId.length === 0 ||
      completionReceipt.resultMessageId.length === 0
    ) {
      throw new NotAuthenticated('Workload completion receipt authority is invalid');
    }
    principal = {
      kind: 'executor-completion-receipt',
      taskId: completionReceipt.taskId,
      sessionId: completionReceipt.sessionId,
      resultMessageId: completionReceipt.resultMessageId,
      tokenFingerprint: executorCandidate.tokenFingerprint,
    };
  } else if (executorCandidate) {
    if (!user?.user_id) throw new NotAuthenticated('Executor user authority is unavailable');
    principal = {
      kind: 'executor',
      ...(executorCandidate.taskId ? { taskId: executorCandidate.taskId } : {}),
      tokenFingerprint: executorCandidate.tokenFingerprint,
      revocationGeneration: executorCandidate.revocationGeneration,
    };
  } else if (isTerminalExecutorIdentity(user)) {
    if (
      !trustedTenant ||
      !user?.terminal_user_id ||
      !user.terminal_id ||
      !user.terminal_branch_id ||
      !user.terminal_owner_boot_id
    ) {
      throw new NotAuthenticated('Terminal connection authority is unavailable');
    }
    principal = {
      kind: 'terminal-executor',
      terminalUserId: user.terminal_user_id,
      terminalId: user.terminal_id,
      branchId: user.terminal_branch_id,
      ownerBootId: user.terminal_owner_boot_id,
    };
  } else if (user?._isServiceAccount === true) {
    principal = { kind: 'service' };
  } else if (user?.user_id) {
    principal = { kind: 'user', userId: user.user_id };
  } else {
    throw new NotAuthenticated('Authenticated principal is unavailable');
  }

  // Restricted terminal executors intentionally receive no Feathers identity
  // projection: they may use their raw terminal capability, but may not enter
  // tenant-owned services. Every other principal receives one immutable,
  // server-owned projection of the result verified at the handshake.
  if (principal.kind !== 'terminal-executor') {
    bindAuthenticatedFeathersProjection(connection, result, trustedTenant);
  }

  const payloadRecord =
    payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : undefined;
  const retireAtExpiry = principal.kind !== 'user' || payloadRecord?.is_impersonated === true;

  const authority = Object.freeze({
    principal: Object.freeze(principal),
    ...(trustedTenant ? { tenant: trustedTenant } : {}),
    ...(expiresAt === undefined ? {} : { expiresAt }),
    retireAtExpiry,
  });
  Object.defineProperty(connection, CONNECTION_AUTHORITY, {
    configurable: true,
    enumerable: false,
    value: authority,
  });
  Object.defineProperty(connection, CONNECTION_AUTHORITY_BOUND, {
    configurable: false,
    enumerable: false,
    value: true,
  });
  return authority;
}

/**
 * Recheck executor admission at each Socket.IO pending-to-active handoff.
 * Other principals do not use the executor revocation fence.
 */
export function isAuthenticatedConnectionAuthorityCurrent(
  authority: AuthenticatedConnectionAuthority,
  fence: ExecutorConnectionRevocationFence
): boolean {
  return (
    authority.principal.kind !== 'executor' ||
    (!!authority.tenant &&
      fence.isCurrent(authority.tenant.tenant_id, authority.principal.revocationGeneration))
  );
}

export function getAuthenticatedConnectionAuthority(
  connection: unknown
): AuthenticatedConnectionAuthority | undefined {
  return connection && typeof connection === 'object'
    ? (connection as AuthorityCarrier)[CONNECTION_AUTHORITY]
    : undefined;
}

/** Retire connection-scoped tenant/executor authority on logout or disconnect. */
export function retireAuthenticatedConnectionAuthority(connection: unknown): void {
  if (!connection || typeof connection !== 'object') return;
  const feathersConnection = connection as AuthenticatedConnection & AuthorityCarrier;
  Reflect.deleteProperty(feathersConnection, CONNECTION_AUTHORITY);
  delete feathersConnection.authenticated;
  delete feathersConnection.authentication;
  delete feathersConnection.tenant;
  delete feathersConnection.user;
}
