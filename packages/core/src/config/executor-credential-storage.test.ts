import { describe, expect, it } from 'vitest';
import { hasTenantSafeExecutorCredentialHome } from './executor-credential-storage';

describe('hasTenantSafeExecutorCredentialHome', () => {
  it('allows an intentional shared identity only for static tenancy', () => {
    expect(
      hasTenantSafeExecutorCredentialHome({
        multi_tenancy: { mode: 'static' },
        execution: { executor_storage: { user_home: 'shared' } },
      })
    ).toBe(true);
  });

  it('requires trusted per-user routing for auth-resolved tenancy', () => {
    expect(
      hasTenantSafeExecutorCredentialHome({
        multi_tenancy: { mode: 'required_from_auth' },
        execution: { executor_storage: { user_home: 'shared' } },
      })
    ).toBe(false);
    expect(
      hasTenantSafeExecutorCredentialHome({
        multi_tenancy: { mode: 'required_from_auth' },
        execution: { executor_storage: { user_home: 'persistent-per-user' } },
      })
    ).toBe(true);
  });
});
