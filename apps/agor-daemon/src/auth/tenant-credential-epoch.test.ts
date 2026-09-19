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
  it('gives a closed record the stable code and an unverifiable read none', async () => {
    // Every JWT path checks the generation before tenant admission, so this is
    // the only rejection a browser on a closed workspace ever sees. It stays a
    // refusal; the code is what lets the tab show the suspended state instead
    // of reporting the member's perfectly good credential as expired.
    for (const phase of ['restricted', 'release_prepared']) {
      read.mockResolvedValue([owner('a'), { ...owner('b'), phase }]);
      const denial = await readTenantCredentialEpoch(db, 'a').catch((error) => error);
      expect(denial).toMatchObject({ code: 401, data: { code: 'tenant_restricted' } });
      // The code is the entire disclosure: no controller, placement, revision
      // or phase may ride along.
      expect(Object.keys(denial.data)).toEqual(['code']);
      await expect(assertTenantCredentialEpoch(db, 'a', {})).rejects.toMatchObject({
        data: { code: 'tenant_restricted' },
      });
    }
    // An observation the daemon could not make is not a statement that the
    // tenant is closed, so it keeps the codeless rejection.
    read.mockRejectedValue(new Error('private connection details'));
    const unverifiable = await readTenantCredentialEpoch(db, 'a').catch((error) => error);
    expect(unverifiable).toMatchObject({ code: 401 });
    expect(unverifiable.data).toBeUndefined();
    // A stale generation against an open tenant is likewise uncoded: the
    // credential really is the thing that was rejected.
    read.mockResolvedValue([owner()]);
    const stale = await assertTenantCredentialEpoch(db, 'a', {
      tenant_credential_epoch: 'f'.repeat(64),
    }).catch((error) => error);
    expect(stale).toMatchObject({ code: 401 });
    expect(stale.data).toBeUndefined();
  });
});
