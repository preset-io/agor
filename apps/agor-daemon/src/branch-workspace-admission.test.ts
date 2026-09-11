import { describe, expect, it } from 'vitest';
import { assertNativeWorkspaceAdmission } from './branch-workspace-admission';

describe('workspace rollout admission', () => {
  it('preserves the default legacy backend and scopes opt-in to a branch and tenant', () => {
    expect(() =>
      assertNativeWorkspaceAdmission({ config: {}, tenantId: 'a', branchId: 'one', state: null })
    ).not.toThrow();
    const config = {
      execution: { branch_workspace: { enabled: true, tenant_ids: ['a'], branch_ids: ['one'] } },
    };
    expect(() =>
      assertNativeWorkspaceAdmission({ config, tenantId: 'b', branchId: 'one', state: null })
    ).not.toThrow();
    expect(() =>
      assertNativeWorkspaceAdmission({ config, tenantId: 'a', branchId: 'one', state: null })
    ).toThrow('awaited workspace');
  });
});
