import { describe, expect, it } from 'vitest';
import { assertDevelopmentDefaultAdminCliRequest, resolveAdminPassword } from './create-admin';

const exactRequest = {
  email: 'admin@agor.live',
  name: 'Admin',
  unixUsername: 'admin',
};

describe('local create-admin development default', () => {
  it.each([
    [
      'production NODE_ENV',
      {
        NODE_ENV: 'production',
        AGOR_ADMIN_PASSWORD: 'admin',
        AGOR_ALLOW_DEVELOPMENT_DEFAULT_ADMIN: 'true',
      },
    ],
    ['missing explicit gate', { NODE_ENV: 'development', AGOR_ADMIN_PASSWORD: 'admin' }],
    [
      'mismatched admin password',
      {
        NODE_ENV: 'development',
        AGOR_ADMIN_PASSWORD: 'not-admin',
        AGOR_ALLOW_DEVELOPMENT_DEFAULT_ADMIN: 'true',
      },
    ],
  ])('rejects %s', (_label, env) => {
    expect(() => assertDevelopmentDefaultAdminCliRequest(exactRequest, env)).toThrow();
  });

  it('accepts only the exact request behind all three environment gates', () => {
    expect(() =>
      assertDevelopmentDefaultAdminCliRequest(exactRequest, {
        NODE_ENV: 'development',
        AGOR_ADMIN_PASSWORD: 'admin',
        AGOR_ALLOW_DEVELOPMENT_DEFAULT_ADMIN: 'true',
      })
    ).not.toThrow();
    expect(() =>
      assertDevelopmentDefaultAdminCliRequest(
        { ...exactRequest, email: 'operator@example.test' },
        {
          NODE_ENV: 'development',
          AGOR_ADMIN_PASSWORD: 'admin',
          AGOR_ALLOW_DEVELOPMENT_DEFAULT_ADMIN: 'true',
        }
      )
    ).toThrow(/exact admin@agor.live/);
  });
});

describe('local create-admin password resolution', () => {
  it('prefers the explicit flag and otherwise reads the canonical environment variable', () => {
    expect(resolveAdminPassword('from-flag', { AGOR_ADMIN_PASSWORD: 'from-env' })).toBe(
      'from-flag'
    );
    expect(resolveAdminPassword(undefined, { AGOR_ADMIN_PASSWORD: 'from-env' })).toBe('from-env');
    expect(resolveAdminPassword(undefined, {})).toBeUndefined();
  });
});
