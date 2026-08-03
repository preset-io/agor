import { Forbidden } from '@agor/core/feathers';
import type { AuthenticatedParams } from '@agor/core/types';

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
