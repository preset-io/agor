/**
 * Launch the `.agorpack` executor legs (`branch.pack.collect` /
 * `branch.pack.materialize`) for one branch as the requesting user, with the
 * same authority resolution as other branch filesystem commands: branch
 * permission + filesystem access, sandbox owner home, delegated home key, and
 * a command token scoped to one pack operation and this branch.
 */

import { type AgorConfig, getBranchHomePath, getTenantDataRoot } from '@agor/core/config';
import {
  BranchRepository,
  runWithTenantDatabaseScope,
  type TenantScopeAwareDatabase,
} from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import type { Branch, DeepReadonly, TenantID, User, UserID, UserRole } from '@agor/core/types';
import { getTeammateConfig } from '@agor/core/types';
import { ensureBranchWorkspaceAccess } from '../utils/branch-workspace-path.js';
import { resolveDelegatedExecutionHomeKey } from '../utils/executor-delegated-home.js';
import { assertManagedBranchPath } from '../utils/managed-branch-path.js';
import { getDaemonUrl, requestExecutor } from '../utils/spawn-executor.js';
import { resolveExecutionCredentialHome } from './credential-home-identity.js';
import { issueExecutorCommandToken } from './session-token-service.js';

function component(value: string): string {
  return encodeURIComponent(value);
}

/** Command identity that also authorizes the fragment upload callback. */
export function agorPackCollectExecutorCommandId(exportId: string): string {
  return `agor-pack.collect:${component(exportId)}`;
}

/** Command identity that also authorizes the staged-pack download callback. */
export function agorPackMaterializeExecutorCommandId(importId: string, key: string): string {
  return `agor-pack.materialize:${component(importId)}:${component(key)}`;
}

export interface AgorPackExecutorContext {
  app: Application;
  db: TenantScopeAwareDatabase;
  config: DeepReadonly<AgorConfig>;
  tenantId: TenantID;
  user: Pick<User, 'user_id' | 'role'>;
}

export async function runAgorPackExecutorCommand(
  ctx: AgorPackExecutorContext,
  input: {
    command: 'branch.pack.collect' | 'branch.pack.materialize';
    commandId: string;
    branch: Branch;
    params: Record<string, unknown>;
  }
): Promise<Record<string, unknown>> {
  const { branch } = input;
  const userId = ctx.user.user_id as UserID;
  const fsAccess = await runWithTenantDatabaseScope(ctx.db, ctx.tenantId, () =>
    ensureBranchWorkspaceAccess(
      new BranchRepository(ctx.db),
      branch,
      userId,
      ctx.user.role as UserRole,
      'all',
      input.command === 'branch.pack.collect' ? 'read' : 'write',
      ctx.config.execution?.allow_superadmin === true
    )
  );
  const sandbox = ctx.config.execution?.sandbox;
  const perUserHome = sandbox?.enabled === true && sandbox.home_mode === 'per_user';
  const sandboxHomeStore = perUserHome
    ? (
        await resolveExecutionCredentialHome({
          userId,
          tenantId: ctx.tenantId,
          config: ctx.config,
          withTenantDatabase: (work) =>
            runWithTenantDatabaseScope(ctx.db, ctx.tenantId, (scoped) => work(scoped)),
        })
      ).homeStore
    : null;
  if (perUserHome && !sandboxHomeStore) {
    throw new Error('Could not resolve an owner home store; refusing to use a shared home');
  }
  const branchHome = getBranchHomePath(branch.branch_id, ctx.tenantId);
  const result = await requestExecutor(
    {
      command: input.command,
      sessionToken: await issueExecutorCommandToken(
        ctx.app,
        input.commandId,
        userId,
        branch.branch_id
      ),
      daemonUrl: getDaemonUrl(),
      params: {
        ...input.params,
        branchId: branch.branch_id,
        localHome: getTeammateConfig(branch)?.localHome === true,
        branchHome,
        tenantDataRoot: getTenantDataRoot(ctx.tenantId),
        cwd: assertManagedBranchPath(branch.path, ctx.tenantId),
        principalBranchAccess: fsAccess,
        sandboxBranchSdkHome: branchHome,
        ...(sandboxHomeStore ? { sandboxHomeStore } : {}),
      },
    },
    {
      logPrefix: `[${input.command} ${branch.branch_id}]`,
      delegatedHomeKey: await runWithTenantDatabaseScope(ctx.db, ctx.tenantId, () =>
        resolveDelegatedExecutionHomeKey(ctx.db, userId, ctx.config)
      ),
      templateVariables: {
        branch_id: branch.branch_id,
        user_id: userId,
        branch_fs_access: fsAccess,
      },
    }
  );
  if (!result.success) {
    throw new Error(result.error?.message ?? `${input.command} failed`);
  }
  return (result.data ?? {}) as Record<string, unknown>;
}
