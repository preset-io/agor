import { describe, expect, it } from 'vitest';
import {
  isDefiniteAuthFailure,
  isTenantRestrictedError,
  isTransientConnectionError,
} from './authErrors';

describe('isDefiniteAuthFailure', () => {
  it('returns true for 401 via `code`, `status`, `statusCode`', () => {
    expect(isDefiniteAuthFailure({ code: 401 })).toBe(true);
    expect(isDefiniteAuthFailure({ status: 401 })).toBe(true);
    expect(isDefiniteAuthFailure({ statusCode: 401 })).toBe(true);
  });

  it('returns false for 403 authorization failures', () => {
    expect(isDefiniteAuthFailure({ code: 403 })).toBe(false);
    expect(isDefiniteAuthFailure({ status: 403 })).toBe(false);
    expect(isDefiniteAuthFailure({ statusCode: 403 })).toBe(false);
  });

  it('returns true for Feathers NotAuthenticated by name or className', () => {
    expect(isDefiniteAuthFailure({ name: 'NotAuthenticated' })).toBe(true);
    expect(isDefiniteAuthFailure({ className: 'not-authenticated' })).toBe(true);
  });

  it('recognizes structured Socket.IO middleware error data', () => {
    expect(
      isDefiniteAuthFailure({
        message: 'Invalid or expired authentication token',
        data: { code: 401, className: 'not-authenticated' },
      })
    ).toBe(true);
  });

  it('returns false for transient / unknown errors', () => {
    expect(isDefiniteAuthFailure({ code: 500 })).toBe(false);
    expect(isDefiniteAuthFailure({ code: 429 })).toBe(false);
    expect(isDefiniteAuthFailure(new TypeError('Failed to fetch'))).toBe(false);
    expect(isDefiniteAuthFailure(null)).toBe(false);
    expect(isDefiniteAuthFailure(undefined)).toBe(false);
    expect(isDefiniteAuthFailure('just a string')).toBe(false);
  });
});

describe('isTransientConnectionError', () => {
  it('returns true for 5xx, 408, 429, and status 0', () => {
    expect(isTransientConnectionError({ code: 500 })).toBe(true);
    expect(isTransientConnectionError({ code: 503 })).toBe(true);
    expect(isTransientConnectionError({ status: 408 })).toBe(true);
    expect(isTransientConnectionError({ status: 429 })).toBe(true);
    expect(isTransientConnectionError({ statusCode: 0 })).toBe(true);
  });

  it('returns true for network-style TypeError fetch failures', () => {
    expect(isTransientConnectionError(new TypeError('Failed to fetch'))).toBe(true);
  });

  it('returns true for transport / websocket message patterns', () => {
    expect(isTransientConnectionError(new Error('websocket connection closed'))).toBe(true);
    expect(isTransientConnectionError(new Error('Network Error'))).toBe(true);
    expect(isTransientConnectionError(new Error('ping timeout'))).toBe(true);
  });

  it('returns false for definite auth failures even if message looks transient', () => {
    // A 401 that happens to have a transport-ish message must NOT be
    // classified as transient — that would keep tokens around on a
    // definite rejection and allow the refresh loop to come back.
    const err = Object.assign(new Error('connection refused'), { code: 401 });
    expect(isTransientConnectionError(err)).toBe(false);
  });

  it('returns false for plain errors with no transient signal', () => {
    expect(isTransientConnectionError(new Error('something boring'))).toBe(false);
    expect(isTransientConnectionError(null)).toBe(false);
    expect(isTransientConnectionError(undefined)).toBe(false);
  });
});

describe('isTenantRestrictedError', () => {
  it('recognizes the code on the 403, the coded 401 and handshake data, keeping tokens without retry', () => {
    // Feathers keeps the status beside `data`; Socket.IO delivers only message + data on connect_error.
    for (const coded of [
      Object.assign(new Error('Tenant access is restricted'), {
        code: 403,
        className: 'forbidden',
        data: { code: 'tenant_restricted' },
      }),
      // The generation check runs ahead of admission, so a closed workspace answers JWT paths with this.
      Object.assign(new Error('Tenant credential cannot be verified'), {
        code: 401,
        className: 'not-authenticated',
        data: { code: 'tenant_restricted' },
      }),
      Object.assign(new Error('Tenant access is restricted'), {
        data: { code: 'tenant_restricted' },
      }),
    ]) {
      expect(isTenantRestrictedError(coded)).toBe(true);
      expect(isDefiniteAuthFailure(coded)).toBe(false);
      expect(isTransientConnectionError(coded)).toBe(false);
    }
  });

  it('never infers a restriction from message text, a bare status, a 503 or an uncoded 401', () => {
    expect(isTenantRestrictedError(new Error('Tenant access is restricted'))).toBe(false);
    expect(isTenantRestrictedError({ code: 403 })).toBe(false);
    expect(
      isTenantRestrictedError(
        Object.assign(new Error('Tenant access cannot be verified'), { code: 503 })
      )
    ).toBe(false);
    expect(isTenantRestrictedError(null)).toBe(false);
    expect(isTenantRestrictedError('tenant_restricted')).toBe(false);
    // A released workspace rejects the stale generation codelessly, which must still fail over to sign-in.
    const stale = Object.assign(new Error('Tenant credential cannot be verified'), {
      code: 401,
      className: 'not-authenticated',
    });
    expect(isTenantRestrictedError(stale)).toBe(false);
    expect(isDefiniteAuthFailure(stale)).toBe(true);
  });
});
