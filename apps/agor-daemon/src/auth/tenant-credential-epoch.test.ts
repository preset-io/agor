import { describe, expect, it, vi } from 'vitest';
import {
  assertTenantCredentialEpoch,
  readTenantCredentialEpoch,
  tenantCredentialEpochClaims,
} from './tenant-credential-epoch.js';

const { read, postgres } = vi.hoisted(() => ({ read: vi.fn(), postgres: vi.fn(() => true) }));
vi.mock('@agor/core/db', () => ({
  readTenantRestrictionIntents: read,
  isPostgresDatabaseHandle: postgres,
}));
const db = {} as never;
const owner = (controllerId = 'a', revision = 2, placementId = 'p') => ({
  controllerId,
  revision,
  placementId,
  phase: 'active',
});

describe('tenant credential watermark', () => {
  it('permits baseline credentials only while history is empty', async () => {
    read.mockResolvedValue([]);
    await expect(assertTenantCredentialEpoch(db, 'a', {})).resolves.toBeUndefined();
    for (const value of [null, 0, '', {}, 'a'.repeat(64)]) {
      await expect(
        assertTenantCredentialEpoch(db, 'a', { tenant_credential_epoch: value })
      ).rejects.toMatchObject({ code: 401 });
    }
    read.mockResolvedValue([owner()]);
    await expect(assertTenantCredentialEpoch(db, 'a', {})).rejects.toMatchObject({ code: 401 });
  });
  it('binds the entire sorted vector and tenant, not just the largest revision', async () => {
    read.mockResolvedValue([owner('a', 100), owner('b', 2)]);
    const epoch = await readTenantCredentialEpoch(db, 'tenant');
    read.mockResolvedValue([owner('b', 2), owner('a', 100)]);
    await expect(
      assertTenantCredentialEpoch(db, 'tenant', tenantCredentialEpochClaims(epoch))
    ).resolves.toBe(epoch);
    for (const records of [
      [owner('a', 100), owner('b', 4)],
      [owner('a', 100), owner('b', 2, 'other')],
    ]) {
      read.mockResolvedValue(records);
      await expect(
        assertTenantCredentialEpoch(db, 'tenant', tenantCredentialEpochClaims(epoch))
      ).rejects.toMatchObject({ code: 401 });
    }
    read.mockResolvedValue([owner('a', 100), owner('b', 2)]);
    await expect(
      assertTenantCredentialEpoch(db, 'neighbor', tenantCredentialEpochClaims(epoch))
    ).rejects.toMatchObject({ code: 401 });
  });
  it('fails closed without private diagnostics and preserves standalone', async () => {
    for (const phase of ['restricted', 'release_prepared']) {
      read.mockResolvedValue([{ ...owner(), phase }]);
      await expect(readTenantCredentialEpoch(db, 'a')).rejects.toMatchObject({ code: 401 });
    }
    read.mockRejectedValue(new Error('private connection details'));
    await expect(readTenantCredentialEpoch(db, 'a')).rejects.toMatchObject({
      message: 'Tenant credential cannot be verified',
    });
    postgres.mockReturnValueOnce(false);
    await expect(assertTenantCredentialEpoch(db, 'a', {})).resolves.toBeUndefined();
  });
});
