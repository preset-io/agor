import type { Branch, BranchMaintenanceCapabilities } from '../types';
import type { AgorConfig } from './types';

/** Runtime support only, never authorization, storage verification, or settlement evidence. */
export function usesExternalBranchExecutor(config: AgorConfig): boolean {
  return (
    config.execution?.unix_user_mode === 'delegated' ||
    Boolean(config.execution?.executor_command_template) ||
    (config.deployment?.mode === 'ha' && config.deployment.ha?.execution_topology === 'external')
  );
}

export function permanentBranchDeletionCapability(
  config: AgorConfig
): BranchMaintenanceCapabilities['permanent_delete'] {
  return usesExternalBranchExecutor(config) && config.execution?.delegated_branch_deletion !== true
    ? {
        supported: false,
        reason:
          'Permanent deletion is not enabled for this delegated/external executor. ' +
          'An operator must verify the deletion storage mount contract before enabling ' +
          'execution.delegated_branch_deletion. No deletion was started.',
      }
    : { supported: true };
}

export function branchMaintenanceCapabilities(
  config: AgorConfig,
  storageMode: Branch['storage_mode']
): BranchMaintenanceCapabilities {
  const workspace: BranchMaintenanceCapabilities['archive_clean'] =
    usesExternalBranchExecutor(config) && storageMode !== 'clone'
      ? {
          supported: false,
          reason:
            'External workspace cleanup/removal requires a self-contained clone. Use Leave untouched for a legacy linked worktree.',
        }
      : { supported: true };
  return {
    archive_preserve: { supported: true },
    archive_clean: workspace,
    archive_remove: workspace,
    permanent_delete: permanentBranchDeletionCapability(config),
  };
}
