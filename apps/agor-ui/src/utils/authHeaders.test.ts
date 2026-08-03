import { beforeEach, describe, expect, it } from 'vitest';
import { getAgorAccessToken, getAuthHeaders, getCurrentUserIdFromJwt } from './authHeaders';

function jwtWithPayload(payload: Record<string, unknown>): string {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString('base64url').replace(/=+$/, '');
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode(payload)}.`;
}

describe('authHeaders', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it('prefers the active Agor access token over the legacy Feathers token', () => {
    sessionStorage.setItem('agor-access-token', 'access-token');
    localStorage.setItem('feathers-jwt', 'legacy-token');

    expect(getAgorAccessToken()).toBe('access-token');
    expect(getAuthHeaders()).toEqual({
      'Content-Type': 'application/json',
      Authorization: 'Bearer access-token',
    });
  });

  it('does not accept the durable legacy Feathers token', () => {
    localStorage.setItem('feathers-jwt', 'legacy-token');

    expect(getAgorAccessToken()).toBeNull();
    expect(getAuthHeaders()).toEqual({
      'Content-Type': 'application/json',
    });
  });

  it('decodes the current user id from the active token', () => {
    sessionStorage.setItem('agor-access-token', jwtWithPayload({ sub: 'user-123' }));
    localStorage.setItem('feathers-jwt', jwtWithPayload({ sub: 'legacy-user' }));

    expect(getCurrentUserIdFromJwt()).toBe('user-123');
  });

  it('fails closed on malformed tokens', () => {
    sessionStorage.setItem('agor-access-token', 'not-a-jwt');

    expect(getCurrentUserIdFromJwt()).toBeNull();
  });
});
