import { describe, expect, it } from 'vitest';
import { getBranchMaintenanceBlockReason } from '../types/branch-cleanup';
import {
  branchMaintenanceCapabilities,
  permanentBranchDeletionCapability,
} from './branch-maintenance';
import type { AgorConfig } from './types';

describe('maintenance runtime support (not authorization)', () => {
  const externalConfigs: AgorConfig[] = [
    { execution: { unix_user_mode: 'delegated' } },
    { execution: { executor_command_template: 'launcher' } },
    { deployment: { mode: 'ha', ha: { execution_topology: 'external' } } },
  ];
  it.each(externalConfigs)(
    'separates clone archive support from permanent deletion: %j',
    (config) => {
      const capability = branchMaintenanceCapabilities(config, 'clone');
      expect(capability.archive_preserve.supported).toBe(true);
      expect(capability.archive_clean.supported).toBe(true);
      expect(capability.archive_remove.supported).toBe(true);
      expect(capability.permanent_delete).toEqual(permanentBranchDeletionCapability(config));
      expect(getBranchMaintenanceBlockReason(capability, 'permanent_delete')).toContain(
        'execution.delegated_branch_deletion'
      );
      const enabled = branchMaintenanceCapabilities(
        {
          ...config,
          execution: { ...config.execution, delegated_branch_deletion: true },
        },
        'clone'
      );
      expect(getBranchMaintenanceBlockReason(enabled, 'permanent_delete')).toBeUndefined();
    }
  );
  it.each(['worktree', undefined] as const)(
    'keeps legacy archive filesystem work unsupported: %s',
    (mode) => {
      const capability = branchMaintenanceCapabilities(externalConfigs[0]!, mode);
      expect(capability.archive_preserve.supported).toBe(true);
      expect(capability.archive_clean.supported).toBe(false);
      expect(capability.archive_remove.supported).toBe(false);
    }
  );
  it.each(['simple', 'sandbox'] as const)(
    'does not gate local %s operations on the external opt-in',
    (mode) => {
      const capability = branchMaintenanceCapabilities(
        { execution: { unix_user_mode: mode } },
        'worktree'
      );
      expect(Object.values(capability).every((value) => value.supported)).toBe(true);
    }
  );
  it('fails closed on missing diagnostics, including older daemons', () => {
    expect(getBranchMaintenanceBlockReason(undefined, 'permanent_delete')).toContain(
      'upgrade the daemon'
    );
  });
});
