import {
  isPostgresDatabaseHandle,
  runWithTenantContext,
  runWithTenantDatabaseScope,
  TaskRepository,
  type TenantScopeAwareDatabase,
} from '@agor/core/db';
import type {
  AuthenticatedParams,
  BranchID,
  McpTaskTokenBinding,
  Session,
  TaskID,
} from '@agor/core/types';
import { authenticatedTaskExecutorRuntimeAuthority } from '../auth/executor-runtime-scope.js';
import type { SessionTokenService } from '../services/session-token-service.js';

export type McpTaskAuthorityStore = Pick<SessionTokenService, 'isTaskTokenAuthorityCurrent'>;

/** Only verified executor authentication can upgrade a session lookup's MCP token. */
export function taskMcpBindingFromParams(
  params: AuthenticatedParams,
  session: Pick<Session, 'session_id' | 'branch_id'>
): McpTaskTokenBinding | undefined {
  const authority = authenticatedTaskExecutorRuntimeAuthority(params);
  // Ordinary APIs may read/create another session. Such a response can carry
  // its normal session token, but can never inherit this executor's identity.
  if (
    !authority ||
    authority.sessionId !== session.session_id ||
    authority.branchId !== session.branch_id
  )
    return undefined;
  const payload = params.authentication?.payload as { jti?: unknown; exp?: unknown } | undefined;
  if (
    authority.userId !== params.user?.user_id ||
    typeof payload?.jti !== 'string' ||
    !payload.jti ||
    typeof payload.exp !== 'number' ||
    !Number.isFinite(payload.exp)
  ) {
    throw new Error('Executor MCP token binding unavailable');
  }
  return {
    executionId: payload.jti,
    taskId: authority.taskId as TaskID,
    branchId: authority.branchId as BranchID,
    tokenFingerprint: authority.tokenFingerprint,
    expiresAt: payload.exp * 1000,
  };
}

/** Read-only: the existing heartbeat authority owns revocation and RBAC checks. */
export async function assertMcpTaskAuthority(
  db: TenantScopeAwareDatabase,
  store: McpTaskAuthorityStore | undefined,
  scope: { tenantId: string; sessionId: string; userId: string },
  binding: McpTaskTokenBinding
): Promise<void> {
  await runWithTenantContext(scope.tenantId, () =>
    runWithTenantDatabaseScope(db, scope.tenantId, async () => {
      const standaloneTokenCurrent = isPostgresDatabaseHandle(db)
        ? undefined
        : await store?.isTaskTokenAuthorityCurrent({
            tenantId: scope.tenantId,
            tokenFingerprint: binding.tokenFingerprint,
            sessionId: scope.sessionId,
            taskId: binding.taskId,
            branchId: binding.branchId,
            userId: scope.userId,
          });
      await new TaskRepository(db).assertRuntimeCredentialAuthority(binding.taskId, {
        token_fingerprint: binding.tokenFingerprint,
        principal_user_id: scope.userId,
        session_id: scope.sessionId,
        branch_id: binding.branchId,
        standalone_token_current: standaloneTokenCurrent,
      });
    })
  );
}
