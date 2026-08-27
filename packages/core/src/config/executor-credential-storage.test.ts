import { describe, expect, it } from 'vitest';
import {
  hasCrossReplicaExecutorCredentialLock,
  hasExactUserExecutorCredentialHome,
  hasTenantSafeExecutorCredentialHome,
} from './executor-credential-storage';

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

describe('hasCrossReplicaExecutorCredentialLock', () => {
  it('requires the explicit cross-client flock assertion', () => {
    expect(
      hasCrossReplicaExecutorCredentialLock({
        execution: { executor_storage: { user_home: 'persistent-per-user' } },
      })
    ).toBe(false);
    expect(
      hasCrossReplicaExecutorCredentialLock({
        execution: {
          executor_storage: {
            user_home: 'persistent-per-user',
            user_home_locking: 'local-only',
          },
        },
      })
    ).toBe(false);
    expect(
      hasCrossReplicaExecutorCredentialLock({
        execution: {
          executor_storage: {
            user_home: 'persistent-per-user',
            user_home_locking: 'cross-replica-flock',
          },
        },
      })
    ).toBe(true);
  });
});

describe('hasExactUserExecutorCredentialHome', () => {
  it('rejects consistent but shared or unrouted local homes', () => {
    expect(
      hasExactUserExecutorCredentialHome({
        execution: { unix_user_mode: 'simple', executor_storage: { user_home: 'shared' } },
      })
    ).toBe(false);
    expect(
      hasExactUserExecutorCredentialHome({
        execution: {
          unix_user_mode: 'simple',
          executor_storage: { user_home: 'persistent-per-user' },
        },
      })
    ).toBe(false);
  });

  it('accepts sandbox and delegated persistent per-user routes', () => {
    expect(
      hasExactUserExecutorCredentialHome({
        execution: {
          unix_user_mode: 'sandbox',
          executor_storage: { user_home: 'persistent-per-user' },
        },
      })
    ).toBe(true);
    expect(
      hasExactUserExecutorCredentialHome({
        execution: {
          unix_user_mode: 'delegated',
          executor_storage: { user_home: 'persistent-per-user' },
        },
      })
    ).toBe(true);
  });
});
