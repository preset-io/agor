import jwt from 'jsonwebtoken';
import { describe, expect, it, vi } from 'vitest';
import { createRefreshTokenService } from './refresh-token-service';
import { issueRuntimeTokenPair } from './runtime-tokens';

const secret = 'refresh-family-test-secret';
const user = {
  user_id: 'user-a',
  email: 'a@example.test',
  role: 'member',
  created_at: new Date(),
} as never;

function setup() {
  const refreshFamilies = {
    rotate: vi.fn(async () => true),
    revokeFamily: vi.fn(async () => undefined),
    revokeAll: vi.fn(async () => undefined),
  };
  const usersService = { get: vi.fn(async () => user) };
  return {
    service: createRefreshTokenService({
      jwtSecret: secret,
      accessTokenTtl: '15m',
      refreshTokenTtl: '30d',
      tenantClaim: 'tenant_id',
      usersService,
      refreshFamilies: refreshFamilies as never,
    }),
    refreshFamilies,
  };
}

describe('refresh token family lifecycle', () => {
  it('rotates a predecessor once and rejects a replay', async () => {
    const { service, refreshFamilies } = setup();
    const token = issueRuntimeTokenPair(user, secret, '15m', '30d', {
      tenant_id: 'tenant-a',
    }).refreshToken;
    const first = await service.create({ refreshToken: token });
    expect(jwt.decode(first.refreshToken)).toMatchObject({
      family_id: (jwt.decode(token) as object & { family_id: string }).family_id,
    });
    refreshFamilies.rotate.mockResolvedValueOnce(false);
    await expect(service.create({ refreshToken: token })).rejects.toThrow(
      'Invalid or expired refresh token'
    );
  });

  it('logout revokes only the presented family', async () => {
    const { service, refreshFamilies } = setup();
    const token = issueRuntimeTokenPair(user, secret, '15m', '30d', {
      tenant_id: 'tenant-a',
    }).refreshToken;
    await expect(service.create({ action: 'logout', refreshToken: token })).resolves.toEqual({
      revoked: true,
    });
    expect(refreshFamilies.revokeFamily).toHaveBeenCalledWith(
      expect.any(String),
      'tenant-a',
      'user-a'
    );
  });

  it('authenticated self revocation revokes every family', async () => {
    const { service, refreshFamilies } = setup();
    const accessToken = issueRuntimeTokenPair(user, secret, '15m', '30d', {
      tenant_id: 'tenant-a',
    }).accessToken;
    await service.create({ action: 'revoke-all', accessToken });
    expect(refreshFamilies.revokeAll).toHaveBeenCalledWith('user-a', 'tenant-a');
  });
});
