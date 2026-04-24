import { describe, expect, it } from 'vitest';
import { isDefiniteAuthFailure, isTransientConnectionError } from './authErrors';

describe('isDefiniteAuthFailure', () => {
  it('returns true for 401 / 403 via `code`, `status`, `statusCode`', () => {
    expect(isDefiniteAuthFailure({ code: 401 })).toBe(true);
    expect(isDefiniteAuthFailure({ status: 403 })).toBe(true);
    expect(isDefiniteAuthFailure({ statusCode: 401 })).toBe(true);
  });

  it('returns true for Feathers NotAuthenticated by name or className', () => {
    expect(isDefiniteAuthFailure({ name: 'NotAuthenticated' })).toBe(true);
    expect(isDefiniteAuthFailure({ className: 'not-authenticated' })).toBe(true);
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
