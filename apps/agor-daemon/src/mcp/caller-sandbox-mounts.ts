/**
 * Resolve local sandbox mounts for a branch command an MCP caller runs as
 * themselves (stateless reads/writes such as Knowledge or gateway uploads).
 *
 * The caller is the execution principal, so a per-user sandbox mounts the
 * caller's home store. Resolution is skipped entirely when the sandbox is off,
 * keeping non-sandbox deployments free of the tenant-identity requirement.
 */

import { getCurrentTenantId } from '@agor/core/db';
import type { Branch } from '@agor/core/types';
import {
  type BranchExecutorSandboxMounts,
  resolveBranchExecutorSandboxMounts,
} from '../utils/branch-executor-sandbox.js';
import type { McpContext } from './server.js';
import { runWithMcpTenantDatabaseScope } from './tenant-scope.js';

export async function resolveMcpCallerSandboxMounts(
  ctx: McpContext,
  branch: Pick<Branch, 'repo_id' | 'storage_mode'>
): Promise<BranchExecutorSandboxMounts> {
  const config = ctx.app.get('config');
  if (config.execution?.sandbox?.enabled !== true) return {};
  return runWithMcpTenantDatabaseScope(ctx, (db) => {
    const tenantId = ctx.baseServiceParams.tenant?.tenant_id ?? getCurrentTenantId();
    if (!tenantId) throw new Error('Trusted tenant context is required');
    return resolveBranchExecutorSandboxMounts({
      config,
      tenantId,
      executionUserId: ctx.userId,
      branch,
      db,
    });
  });
}
