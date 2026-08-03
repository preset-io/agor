import { Forbidden } from '@agor/core/feathers';
import { describe, expect, it } from 'vitest';
import { requireSharedOAuthAdministrator } from './shared-oauth-policy';

const params = (role: 'member' | 'admin') =>
  ({ provider: 'rest', user: { user_id: `${role}-user`, role } }) as never;

describe('requireSharedOAuthAdministrator', () => {
  it('rejects an ordinary member mutating the tenant-wide identity', () => {
    expect(() =>
      requireSharedOAuthAdministrator({ kind: 'actor', params: params('member') }, 'refresh')
    ).toThrow(Forbidden);
  });

  it('fails closed when actor context is missing', () => {
    expect(() =>
      requireSharedOAuthAdministrator({ kind: 'actor', params: undefined }, 'start')
    ).toThrow('Authentication required');
  });

  it('allows administrators and explicitly trusted internal calls', () => {
    expect(() =>
      requireSharedOAuthAdministrator({ kind: 'actor', params: params('admin') }, 'disconnect')
    ).not.toThrow();
    expect(() =>
      requireSharedOAuthAdministrator({ kind: 'trusted-internal' }, 'start')
    ).not.toThrow();
  });
});
