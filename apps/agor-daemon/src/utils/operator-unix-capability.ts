import { Forbidden } from '@agor/core/feathers';
import type { AuthenticatedParams } from '@agor/core/types';
import {
  generateScopedServiceToken,
  getDaemonUrl,
  runOperatorUnixPermissionCommand,
} from './spawn-executor.js';

/** Authorize the one-shot Git executor → operator Unix-sync handoff. */
export function assertOperatorUnixHandoff(
  params: AuthenticatedParams | undefined,
  expected:
    | { command: 'git.clone'; repoId: string }
    | { command: 'git.branch.add'; branchId: string }
): void {
  const payload = params?.authentication?.payload as
    | { command?: unknown; repo_id?: unknown; branch_id?: unknown; tenant_id?: unknown }
    | undefined;
  const resourceMatches =
    expected.command === 'git.clone'
      ? payload?.repo_id === expected.repoId
      : payload?.branch_id === expected.branchId;
  const tenantMatches =
    typeof params?.tenant?.tenant_id === 'string' && payload?.tenant_id === params.tenant.tenant_id;
  if (
    !params?.provider ||
    !params.user ||
    !(params.user as { _isServiceAccount?: boolean })._isServiceAccount ||
    payload?.command !== expected.command ||
    !resourceMatches ||
    !tenantMatches
  ) {
    throw new Forbidden(`Unix sync requires the matching ${expected.command} tenant capability`);
  }
}

/** Mint and execute the narrow operator capability shared by repo/branch lifecycle services. */
export async function dispatchOperatorUnixHandoff(options: {
  app: { settings: { authentication?: { secret?: string } } };
  target:
    | { command: 'unix.sync-repo'; repoId: string; creatorUserId?: string }
    | { command: 'unix.sync-branch'; branchId: string };
  daemonUser?: string;
}): Promise<string> {
  const { target } = options;
  const isRepo = target.command === 'unix.sync-repo';
  const resourceId = isRepo ? target.repoId : target.branchId;
  const token = generateScopedServiceToken(options.app, {
    command: target.command,
    ...(isRepo
      ? { repo_id: target.repoId, user_id: target.creatorUserId }
      : { branch_id: target.branchId }),
  });
  const result = await runOperatorUnixPermissionCommand(
    {
      command: target.command,
      sessionToken: token,
      daemonUrl: getDaemonUrl(),
      params: isRepo
        ? {
            repoId: target.repoId,
            daemonUser: options.daemonUser,
            initialize: true,
            ...(target.creatorUserId ? { creatorUserId: target.creatorUserId } : {}),
          }
        : { branchId: target.branchId, daemonUser: options.daemonUser },
    },
    { logPrefix: `[operator/${target.command} ${resourceId}]` }
  );
  if (!result.success) {
    throw new Error(result.error?.message ?? `Operator ${target.command} failed`);
  }
  const unixGroup = (result.data as { groupName?: unknown } | undefined)?.groupName;
  if (typeof unixGroup !== 'string') {
    throw new Error(`Operator ${target.command} returned no group`);
  }
  return unixGroup;
}
