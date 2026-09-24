/**
 * The classifier is the difference between `reason=unexpected` and a log line
 * an operator can act on.
 *
 * Driven against the REAL error values wherever one exists, rather than
 * hand-built look-alikes: the whole point of classifying by shape is that the
 * shape is whatever the throwing code actually produces.
 */

import { PublicBaseUrlNotConfiguredError } from '@agor/core/config';
import {
  MissingTenantDatabaseScopeError,
  RepositoryError,
  TenantPublicBaseUrlError,
} from '@agor/core/db';
import { describe, expect, it } from 'vitest';
import { classifyGatewayReadFailure } from './gateway-read-failure.js';

describe('classifyGatewayReadFailure', () => {
  it('names the tenant-scope class, which this lane has now shipped seven times', () => {
    expect(classifyGatewayReadFailure(new MissingTenantDatabaseScopeError('messages'))).toBe(
      'missing_tenant_scope'
    );
  });

  /**
   * The live incident's own exception. It was a bare `new Error` until this
   * change, so the only thing that distinguished it from its sibling was its
   * message — which `context/guidelines/logging.md` forbids logging, and which
   * a classifier therefore must not read.
   */
  it('names the two tenant public-link failures apart', () => {
    expect(
      classifyGatewayReadFailure(
        new TenantPublicBaseUrlError(
          'TENANT_PUBLIC_BASE_URL_DATABASE_REQUIRED',
          'Tenant public links require a tenant database'
        )
      )
    ).toBe('missing_tenant_scope');
    expect(
      classifyGatewayReadFailure(
        new TenantPublicBaseUrlError(
          'TENANT_PUBLIC_BASE_URL_IDENTITY_REQUIRED',
          'Tenant public links require trusted tenant identity'
        )
      )
    ).toBe('missing_tenant_identity');
  });

  it('names an unconfigured public base URL', () => {
    expect(classifyGatewayReadFailure(new PublicBaseUrlNotConfiguredError('no url'))).toBe(
      'no_public_base_url'
    );
  });

  /**
   * The shape §9/F4 was actually found in: a repository wrapper over the
   * useful answer. The wrapper is the less informative of the two, so the
   * cause decides whenever it can.
   */
  it('looks through a repository wrapper to the cause', () => {
    expect(
      classifyGatewayReadFailure(
        new RepositoryError(
          'Failed to get OAuth token',
          new MissingTenantDatabaseScopeError('user_mcp_oauth_tokens')
        )
      )
    ).toBe('missing_tenant_scope');
  });

  it('falls back to the wrapper when the cause says nothing useful', () => {
    expect(classifyGatewayReadFailure(new RepositoryError('boom', new Error('SQLITE_BUSY')))).toBe(
      'repository_error'
    );
  });

  it('never reads the message', () => {
    // The incident's exact text, on an error with no shape at all.
    expect(
      classifyGatewayReadFailure(new Error('Tenant public links require a tenant database'))
    ).toBe('unexpected');
  });

  it('survives values that are not errors, and cause cycles', () => {
    expect(classifyGatewayReadFailure(undefined)).toBe('unexpected');
    expect(classifyGatewayReadFailure('a string')).toBe('unexpected');
    expect(classifyGatewayReadFailure({ code: 42 })).toBe('unexpected');
    const cyclic = new Error('outer') as Error & { cause?: unknown };
    cyclic.cause = cyclic;
    expect(classifyGatewayReadFailure(cyclic)).toBe('unexpected');
  });

  it('refuses a thrown value whose properties throw', () => {
    const hostile = {
      get code(): string {
        throw new Error('nope');
      },
      get name(): string {
        throw new Error('nope');
      },
    };
    expect(classifyGatewayReadFailure(hostile)).toBe('unexpected');
  });
});
