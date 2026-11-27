import type { AgorConfig } from '@agor/core/config';
import type { TenantScopeAwareDatabase } from '@agor/core/db';
import {
  assertTenantWritable,
  isPostgresDatabaseHandle,
  runWithTenantDatabaseScope,
} from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import type { Branch, DeepReadonly, Session, Task, UserID } from '@agor/core/types';
import { resolveBranchSdkHomeLaunch } from '../branch-sdk-home.js';
import { resolveBranchExecutorSandboxMounts } from '../utils/branch-executor-sandbox.js';
import { resolveDelegatedExecutionHomeKey } from '../utils/executor-delegated-home.js';
import { assertManagedBranchPath } from '../utils/managed-branch-path.js';
import { getDaemonUrl, requestExecutor } from '../utils/spawn-executor.js';
import { issueExecutorCommandToken } from './session-token-service.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * A Session SDK handle alone is writable metadata. Use only the provider
 * identity recorded by a completed, authenticated task that created it.
 */
export function ownedScheduledCodexThread(session: Session, tasks: Task[]): string | undefined {
  const id = session.sdk_session_id;
  if (
    session.agentic_tool !== 'codex' ||
    session.sdk_home_scope !== 'branch' ||
    !session.scheduled_from_branch ||
    !session.schedule_id ||
    !session.branch_id ||
    typeof id !== 'string' ||
    !uuid.test(id)
  )
    return;
  if (tasks.some((task) => task.session_id !== session.session_id)) return;
  if (
    tasks.some((task) => {
      const result = task.raw_sdk_response as
        | { agor_created_thread?: { id?: unknown; branch_id?: unknown } }
        | undefined;
      return (
        task.status === 'completed' &&
        result?.agor_created_thread?.id === id &&
        result.agor_created_thread.branch_id === session.branch_id
      );
    })
  )
    return id;
}

export async function retireScheduledCodexThread(input: {
  app: Application;
  db: TenantScopeAwareDatabase;
  config: DeepReadonly<AgorConfig>;
  tenantId: string;
  branch: Branch;
  userId: UserID;
  threadId: string;
}): Promise<boolean> {
  const { app, branch, config, db, tenantId, userId, threadId } = input;
  if (branch.sdk_home !== 'per_branch' || !branch.path || !uuid.test(branch.branch_id))
    return false;
  const launch = resolveBranchSdkHomeLaunch({
    tool: 'codex',
    branchId: branch.branch_id,
    tenantId,
  });
  const { token, delegatedHomeKey, mounts } = await runWithTenantDatabaseScope(
    db,
    tenantId,
    async (scoped) => {
      if (isPostgresDatabaseHandle(db)) await assertTenantWritable(scoped, tenantId);
      return {
        token: await issueExecutorCommandToken(
          app,
          'codex-thread-retire',
          userId,
          branch.branch_id
        ),
        delegatedHomeKey: await resolveDelegatedExecutionHomeKey(db, userId, config),
        mounts: await resolveBranchExecutorSandboxMounts({
          config,
          tenantId,
          executionUserId: userId,
          branch,
          db,
        }),
      };
    }
  );
  const result = await requestExecutor(
    {
      command: 'codex.thread-retire',
      sessionToken: token,
      daemonUrl: getDaemonUrl(),
      params: {
        branchId: branch.branch_id,
        threadId,
        codexHome: launch.envVars.CODEX_SQLITE_HOME,
        cwd: assertManagedBranchPath(branch.path, tenantId),
        principalBranchAccess: 'read',
        sandboxBranchSdkHome: launch.branchHomeDir,
        ...mounts,
      },
    },
    {
      delegatedHomeKey: delegatedHomeKey ?? undefined,
      templateVariables: {
        branch_id: branch.branch_id,
        user_id: userId,
        branch_sdk_home: launch.branchHomeDir,
        branch_fs_access: 'read',
      },
      timeoutMs: 20_000,
      sensitiveOutput: true,
      logPrefix: '[ScheduledCodexRetirement]',
    }
  );
  return result.success && (result.data as { status?: string } | undefined)?.status === 'retired';
}
