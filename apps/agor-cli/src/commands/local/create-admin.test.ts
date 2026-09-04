import { BootstrapTenantUnsupportedError } from '@agor/core/config';
import { describe, expect, it } from 'vitest';
import {
  assertDevelopmentDefaultAdminCliRequest,
  presentCreateAdminFailure,
  resolveAdminPassword,
} from './create-admin';

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

describe('create-admin failure presentation', () => {
  it('surfaces the single-tenant rejection verbatim (not flattened by DB sanitization)', () => {
    const error = new BootstrapTenantUnsupportedError(
      'This command operates on the static single tenant and is not supported when ' +
        'multi_tenancy.mode=required_from_auth.'
    );
    // The message must survive create-admin's catch path, which otherwise routes
    // errors through sanitizeDbError → "Database operation failed".
    expect(presentCreateAdminFailure(error)).toBe(error.message);
    expect(presentCreateAdminFailure(error)).not.toMatch(/Database operation failed/);
  });

  it('flattens ordinary database errors through the sanitizer', () => {
    const dbError = Object.assign(new Error('duplicate key value violates unique constraint'), {
      code: '23505',
    });
    expect(presentCreateAdminFailure(dbError)).not.toMatch(/duplicate key/);
    expect(presentCreateAdminFailure(dbError)).toMatch(/Database/);
  });
});
