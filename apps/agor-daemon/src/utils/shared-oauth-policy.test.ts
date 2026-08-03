import { Forbidden } from '@agor/core/feathers';
import { describe, expect, it } from 'vitest';
import { requireSharedOAuthAdministrator } from './shared-oauth-policy';

const params = (role: 'member' | 'admin') =>
  ({ provider: 'rest', user: { user_id: `${role}-user`, role } }) as never;

describe('requireSharedOAuthAdministrator', () => {
  it('rejects an ordinary member mutating the tenant-wide identity', () => {
    expect(() => requireSharedOAuthAdministrator(params('member'), 'refresh')).toThrow(Forbidden);
  });

  it('allows administrators and trusted internal calls', () => {
    expect(() => requireSharedOAuthAdministrator(params('admin'), 'disconnect')).not.toThrow();
    expect(() => requireSharedOAuthAdministrator({} as never, 'start')).not.toThrow();
  });
});
