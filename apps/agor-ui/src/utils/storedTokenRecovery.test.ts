import { beforeEach, describe, expect, it, vi } from 'vitest';
import { refreshTokensSingleFlight } from './singleFlightRefresh';
import { readStoredCredentialOwner, refreshStoredAccessTokenForOwner } from './storedTokenRecovery';
import { REFRESH_TOKEN_KEY } from './tokenRefresh';

vi.mock('@agor-live/client', () => ({ createRestClient: vi.fn(async () => ({})) }));
vi.mock('./singleFlightRefresh', () => ({ refreshTokensSingleFlight: vi.fn() }));

function jwtFor(claims: Record<string, unknown>): string {
  return `header.${btoa(JSON.stringify(claims)).replace(/=+$/, '')}.signature`;
}

describe('stored token recovery', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.mocked(refreshTokensSingleFlight).mockReset();
  });

  it('pins no owner for a missing or undecodable token', () => {
    expect(readStoredCredentialOwner(null)).toBeNull();
    expect(readStoredCredentialOwner('opaque-token')).toBeNull();
    expect(readStoredCredentialOwner(jwtFor({ exp: 1 }))).toBeNull();
  });

  it('returns a refreshed token only for the same user and tenant', async () => {
    localStorage.setItem(REFRESH_TOKEN_KEY, 'refresh-token');
    const owner = readStoredCredentialOwner(jwtFor({ sub: 'user-a', tenant_id: 'tenant-1' }));
    if (!owner) throw new Error('expected owner');

    const sameOwner = jwtFor({ sub: 'user-a', tenant_id: 'tenant-1' });
    vi.mocked(refreshTokensSingleFlight).mockResolvedValueOnce({
      accessToken: sameOwner,
      user: {} as never,
    });
    await expect(refreshStoredAccessTokenForOwner('https://daemon', owner)).resolves.toBe(
      sameOwner
    );

    vi.mocked(refreshTokensSingleFlight).mockResolvedValueOnce({
      accessToken: jwtFor({ sub: 'user-a', tenant_id: 'tenant-2' }),
      user: {} as never,
    });
    await expect(refreshStoredAccessTokenForOwner('https://daemon', owner)).resolves.toBeNull();
  });

  it('does not attempt a refresh without a stored refresh token', async () => {
    await expect(
      refreshStoredAccessTokenForOwner('https://daemon', { subject: 'user-a', tenantId: null })
    ).resolves.toBeNull();
    expect(refreshTokensSingleFlight).not.toHaveBeenCalled();
  });
});
