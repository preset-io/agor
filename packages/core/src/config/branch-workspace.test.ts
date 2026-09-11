import { describe, expect, it } from 'vitest';
import { resolveBranchWorkspaceConfig, usesReplicatedWorkspace } from './branch-workspace';

describe('branch workspace config', () => {
  it('defaults off and supports branch/tenant allowlists', () => {
    expect(resolveBranchWorkspaceConfig().enabled).toBe(false);
    const config = { enabled: true, tenant_ids: ['t'], branch_ids: ['b'] };
    expect(usesReplicatedWorkspace(config, 't', 'b')).toBe(true);
    expect(usesReplicatedWorkspace(config, 'other', 'b')).toBe(false);
    expect(usesReplicatedWorkspace(config, 't', 'other')).toBe(false);
  });
  it('refuses unsafe semantics, bad limits and misspellings', () => {
    expect(() => resolveBranchWorkspaceConfig({ tool_boundary_sync: false } as never)).toThrow();
    expect(() => resolveBranchWorkspaceConfig({ maximum_active_tools: 0 })).toThrow();
    expect(() => resolveBranchWorkspaceConfig({ enabeld: true } as never)).toThrow();
  });
});
