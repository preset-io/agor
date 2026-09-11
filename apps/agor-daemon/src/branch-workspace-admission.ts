import { type AgorConfig, usesReplicatedWorkspace } from '@agor/core/config';
import type { WorkspaceState } from '@agor/core/workspaces/types';

/** Never let an unfenced legacy SDK mutate the source of an adopted workspace. */
export function assertNativeWorkspaceAdmission(input: {
  config: Pick<AgorConfig, 'execution'>;
  tenantId: string;
  branchId: string;
  state: WorkspaceState | null;
}): void {
  if (
    input.state ||
    usesReplicatedWorkspace(
      input.config.execution?.branch_workspace,
      input.tenantId,
      input.branchId
    )
  ) {
    throw new Error(
      'This branch requires awaited workspace tool boundaries. Native SDK execution is not yet supported by the replicated workspace backend; use its managed tool controller or explicitly export and roll back the branch.'
    );
  }
}
