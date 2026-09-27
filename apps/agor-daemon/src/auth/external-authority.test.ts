import { generateKeyPairSync } from 'node:crypto';
import { type AgorConfig, resolveExternalLaunchSettings } from '@agor/core/config';
import {
  ExternalUserAuthorityRepository,
  runWithTenantDatabaseScope,
  UsersRepository,
} from '@agor/core/db';
import jwt from 'jsonwebtoken';
import { afterEach, expect, vi } from 'vitest';
import { dbTest } from '../../../../packages/core/src/db/test-helpers';
import { UsersService } from '../services/users.js';
import { createExternalAuthorityService } from './external-authority.js';
import { createLaunchAuthService } from './launch-auth.js';

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const issuer = 'https://authority.example.test';
const config: AgorConfig = {
  identity: {
    user_lifecycle: 'external',
    role_authority: 'claims',
    local_auth: 'disabled',
    external: { provider: 'external_launch', provisioning: 'jit' },
  },
  external_launch: {
    enabled: true,
    issuer,
    audience: 'launch:test',
    exchange_url: `${issuer}/exchange`,
    dev_shared_secret: 'synthetic-launch-secret',
    authority: {
      cell_id: 'test',
      tenant_ids: ['default'],
      public_key: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    },
  },
};
function assertion(overrides: Record<string, unknown> = {}) {
  return jwt.sign(
    {
      sub: 'subject',
      provider: issuer,
      cell_id: 'test',
      workspace_id: 'default',
      tenant_id: 'default',
      purpose: 'external-authority-v1',
      jti: 'test-update',
      revision: '1',
      login_epoch: '1',
      active: true,
      role: 'member',
      ...overrides,
    },
    privateKey,
    { algorithm: 'RS256', issuer, audience: 'agor-authority:test', expiresIn: 60 }
  );
}
afterEach(() => vi.unstubAllGlobals());

dbTest(
  'signed updates survive missing projections, replay, disable/re-enable and old launch ordering',
  async ({ db }) => {
    const invalidated = vi.fn();
    const service = createExternalAuthorityService({ db, config, invalidated });
    const usersService = new UsersService(db, undefined, config);
    const launch = createLaunchAuthService({
      db,
      config,
      provider: resolveExternalLaunchSettings(config).settings,
      jwtSecret: 'synthetic-runtime-secret',
      accessTokenTtl: '15m',
      refreshTokenTtl: '30d',
      usersService,
    });
    const open = (revision: string, epoch: string) => {
      const token = jwt.sign(
        {
          sub: 'subject',
          email: 'subject@example.test',
          role: 'member',
          authority_revision: revision,
          login_epoch: epoch,
        },
        'synthetic-launch-secret',
        { issuer, audience: 'launch:test', expiresIn: 60 }
      );
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => Response.json({ assertion: token }))
      );
      return launch.create({ launchCode: 'synthetic-code' });
    };
    await expect(open('1', '1')).rejects.toThrow(/authority/);
    // A disable before first JIT must leave a durable tombstone, not disappear.
    await service.create({ assertion: assertion({ active: false }) });
    await expect(open('1', '1')).rejects.toThrow(/authority/);
    await service.create({ assertion: assertion({ revision: '2', login_epoch: '2' }) });
    const first = await open('2', '2');
    await service.create({
      assertion: assertion({ revision: '3', login_epoch: '3', active: false }),
    });
    expect((await new UsersRepository(db).findById(first.user.user_id))?.access_disabled).toBe(
      true
    );
    expect(
      await service.create({ assertion: assertion({ revision: '2', login_epoch: '2' }) })
    ).toMatchObject({ outcome: 'superseded', applied_revision: '3' });
    await service.create({ assertion: assertion({ revision: '4', login_epoch: '4' }) });
    await expect(open('2', '2')).rejects.toThrow(/authority/);
    expect((await open('4', '4')).user.user_id).toBe(first.user.user_id);
    expect(
      await service.create({ assertion: assertion({ revision: '4', login_epoch: '4' }) })
    ).toMatchObject({ outcome: 'duplicate' });
    await expect(
      service.create({ assertion: assertion({ revision: '4', login_epoch: '4', active: false }) })
    ).rejects.toThrow(/Conflicting/);
    await expect(
      service.create({ assertion: assertion({ revision: '5', login_epoch: '3' }) })
    ).rejects.toThrow(/epoch/);
    await expect(
      usersService.patch(first.user.user_id, { access_disabled: true })
    ).rejects.toThrow();
    expect(invalidated).toHaveBeenCalledTimes(2);
  }
);

dbTest(
  'wrong tenant, Cell, purpose, subject and launch audience cannot administrate authority',
  async ({ db }) => {
    const service = createExternalAuthorityService({ db, config, invalidated: vi.fn() });
    for (const changes of [
      { tenant_id: 'other', workspace_id: 'other' },
      { workspace_id: 'other' },
      { cell_id: 'other' },
      { purpose: 'launch' },
      { provider: 'other' },
      { sub: '' },
      { role: 'superadmin' },
      { revision: '9007199254740993.0' },
      { login_epoch: '-1' },
    ])
      await expect(service.create({ assertion: assertion(changes) })).rejects.toThrow(/Invalid/);
    const wrongAudience = jwt.sign({ sub: 'subject' }, privateKey, {
      algorithm: 'RS256',
      issuer,
      audience: 'launch:test',
      expiresIn: 60,
    });
    await expect(service.create({ assertion: wrongAudience })).rejects.toThrow(/Invalid/);
    const validClaims = jwt.decode(assertion()) as jwt.JwtPayload;
    for (const overrides of [
      { iss: 'https://wrong.example.test' },
      { exp: 1 },
      { iat: Math.floor(Date.now() / 1000) + 120 },
    ]) {
      const invalid = jwt.sign({ ...validClaims, ...overrides }, privateKey, {
        algorithm: 'RS256',
      });
      await expect(service.create({ assertion: invalid })).rejects.toMatchObject({ code: 401 });
    }
    await runWithTenantDatabaseScope(db, 'default', async (scoped) => {
      expect(
        await new ExternalUserAuthorityRepository(scoped).find(issuer, issuer, 'subject')
      ).toBeFalsy();
    });
  }
);
