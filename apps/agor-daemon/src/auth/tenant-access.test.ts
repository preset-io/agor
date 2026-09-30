import { createDatabase, runWithTenantContext, type TenantRestrictionState } from '@agor/core/db';
import type { TenantRestrictionRecord } from '@agor/core/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertRuntimeTenantAccess,
  gatewayOccurrenceTime,
  isCurrentTenantEventAdmitted,
  isTenantRestrictedRejection,
} from './tenant-access.js';
import {
  assertTenantCredentialEpoch,
  readTenantCredentialEpoch,
  tenantCredentialEpochClaims,
} from './tenant-credential-epoch.js';
import { assertTenantLaunchRevision } from './tenant-launch-revision.js';

const { read, postgres } = vi.hoisted(() => ({ read: vi.fn(), postgres: vi.fn(() => true) }));
vi.mock('@agor/core/db', async (original) => ({
  ...(await original<typeof import('@agor/core/db')>()),
  readTenantRestrictionState: read,
  isPostgresDatabaseHandle: postgres,
}));

const db = {} as never;
const owner = (
  controllerId = 'a',
  revision = 2,
  phase: TenantRestrictionRecord['phase'] = 'active',
  placementId = 'p'
): TenantRestrictionRecord => ({
  version: 1,
  controllerId,
  placementId,
  operationId: 'op',
  revision,
  phase,
});
const state = (...records: TenantRestrictionRecord[]): TenantRestrictionState => ({
  records,
  closed: records.some((record) => record.phase !== 'active'),
});
const closedStates = [
  state(owner('a', 2, 'restricted')),
  state(owner('a'), owner('b', 1, 'release_prepared')),
];

afterEach(() => {
  read.mockReset();
  postgres.mockReset();
  postgres.mockReturnValue(true);
  vi.useRealTimers();
});

describe('admission from one restriction read', () => {
  it('preserves standalone SQLite without reading or claiming restriction support', async () => {
    postgres.mockReturnValue(false);
    await expect(
      assertRuntimeTenantAccess(createDatabase({ url: ':memory:' }), 'default', { payload: {} })
    ).resolves.toBeUndefined();
    await expect(assertTenantCredentialEpoch(db, 'a', {})).resolves.toBeUndefined();
    expect(read).not.toHaveBeenCalled();
  });

  it.each(closedStates)('maps a closed tenant to the neutral coded 403: %#', async (closed) => {
    read.mockResolvedValue(closed);
    const denial = await assertRuntimeTenantAccess(db, 'a', { payload: {} }).catch((e) => e);
    expect(denial).toMatchObject({ code: 403, message: 'Tenant access is restricted' });
    expect(denial.data).toEqual({ code: 'tenant_restricted' });
    expect(isTenantRestrictedRejection(denial)).toBe(true);
    // Every JWT path checks the generation before admission, so it carries the same code.
    const credential = await readTenantCredentialEpoch(db, 'a').catch((e) => e);
    expect(credential).toMatchObject({ code: 401, data: { code: 'tenant_restricted' } });
    expect(Object.keys(credential.data)).toEqual(['code']);
  });

  it.each([new Error('private database address'), new Error('invalid controller private-id')])(
    'fails an unverifiable read closed, codeless and without diagnostics: %s',
    async (error) => {
      read.mockRejectedValue(error);
      const failure = await assertRuntimeTenantAccess(db, 'a').catch((e) => e);
      expect(failure).toMatchObject({ code: 503, message: 'Tenant access cannot be verified' });
      expect(isTenantRestrictedRejection(failure)).toBe(false);
      const credential = await readTenantCredentialEpoch(db, 'a').catch((e) => e);
      expect(credential).toMatchObject({
        code: 401,
        message: 'Tenant credential cannot be verified',
      });
      expect(credential.data).toBeUndefined();
    }
  );

  it('checks the signed generation from the same read and leaves a stale one codeless', async () => {
    read.mockResolvedValue(state(owner()));
    const epoch = await readTenantCredentialEpoch(db, 'a');
    await expect(
      assertRuntimeTenantAccess(db, 'a', { payload: tenantCredentialEpochClaims(epoch) })
    ).resolves.toBeUndefined();
    const stale = await assertRuntimeTenantAccess(db, 'a', {
      payload: { tenant_credential_epoch: 'f'.repeat(64) },
    }).catch((e) => e);
    expect(stale).toMatchObject({ code: 401 });
    expect(stale.data).toBeUndefined();
    await expect(assertRuntimeTenantAccess(db, 'a')).resolves.toBeUndefined();
    expect(read).toHaveBeenCalledTimes(4);
  });
});

describe('tenant credential watermark', () => {
  it('permits baseline credentials only while history is empty', async () => {
    read.mockResolvedValue(state());
    await expect(assertTenantCredentialEpoch(db, 'a', {})).resolves.toBeUndefined();
    for (const value of [null, 0, '', {}, 'a'.repeat(64)]) {
      await expect(
        assertTenantCredentialEpoch(db, 'a', { tenant_credential_epoch: value })
      ).rejects.toMatchObject({ code: 401 });
    }
    read.mockResolvedValue(state(owner()));
    await expect(assertTenantCredentialEpoch(db, 'a', {})).rejects.toMatchObject({ code: 401 });
  });

  it('binds the entire sorted vector and tenant, not just the largest revision', async () => {
    read.mockResolvedValue(state(owner('a', 100), owner('b', 2)));
    const claims = tenantCredentialEpochClaims(await readTenantCredentialEpoch(db, 'tenant'));
    read.mockResolvedValue(state(owner('b', 2), owner('a', 100)));
    await expect(assertTenantCredentialEpoch(db, 'tenant', claims)).resolves.toBeDefined();
    for (const changed of [
      state(owner('a', 100), owner('b', 4)),
      state(owner('a', 100), owner('b', 2, 'active', 'other')),
    ]) {
      read.mockResolvedValue(changed);
      await expect(assertTenantCredentialEpoch(db, 'tenant', claims)).rejects.toMatchObject({
        code: 401,
      });
    }
    read.mockResolvedValue(state(owner('a', 100), owner('b', 2)));
    await expect(assertTenantCredentialEpoch(db, 'neighbor', claims)).rejects.toMatchObject({
      code: 401,
    });
  });
});

describe('launch revision', () => {
  const reject = { code: 401 };
  it('allows only legacy zero baseline without a retained watermark', () => {
    expect(() => assertTenantLaunchRevision(state(), undefined)).not.toThrow();
    expect(() =>
      assertTenantLaunchRevision(state(), { controllerId: 'cloud', revision: 0 }, 'cloud')
    ).not.toThrow();
    for (const claim of [
      { controllerId: 'cloud', revision: 2 },
      { controllerId: 'other', revision: 0 },
      { controllerId: 'cloud', revision: -1 },
      { controllerId: 'cloud', revision: 0, extra: true },
    ]) {
      expect(() => assertTenantLaunchRevision(state(), claim, 'cloud')).toThrow(
        expect.objectContaining(reject)
      );
    }
  });

  it('requires the exact configured owner and every owner active', () => {
    const current = state(owner('cloud', 2));
    expect(() =>
      assertTenantLaunchRevision(current, { controllerId: 'cloud', revision: 2 }, 'cloud')
    ).not.toThrow();
    for (const [restriction, claim, configured] of [
      [current, undefined, 'cloud'],
      [current, { controllerId: 'cloud', revision: 0 }, 'cloud'],
      [current, { controllerId: 'cloud', revision: 1 }, 'cloud'],
      [current, { controllerId: 'other', revision: 2 }, 'cloud'],
      [current, { controllerId: 'cloud', revision: 2 }, undefined],
      [state(owner('other', 2)), { controllerId: 'cloud', revision: 2 }, 'cloud'],
      [
        state(owner('cloud', 2), owner('other', 1, 'restricted')),
        { controllerId: 'cloud', revision: 2 },
        'cloud',
      ],
    ] as const) {
      expect(() => assertTenantLaunchRevision(restriction, claim, configured)).toThrow(
        expect.objectContaining(reject)
      );
    }
  });
});

it('normalizes provider occurrence time rather than arrival time', () => {
  expect(gatewayOccurrenceTime('1700000000.123456')).toBe(1700000000123.456);
  expect(gatewayOccurrenceTime('2026-09-16T12:00:00.000Z')).toBe(
    Date.parse('2026-09-16T12:00:00.000Z')
  );
  expect(gatewayOccurrenceTime('invalid')).toBeNaN();
});

it('requires future source events after durable activation and never opens a closed boundary', async () => {
  read.mockResolvedValue({ ...state(owner()), resumeAfter: 100 });
  await runWithTenantContext('tenant-a', async () => {
    for (const at of [0, 100, NaN])
      expect(await isCurrentTenantEventAdmitted({} as never, at)).toBe(false);
    expect(await isCurrentTenantEventAdmitted({} as never, 101)).toBe(true);
    read.mockResolvedValue({ ...state(owner('a', 2, 'restricted')), resumeAfter: 100 });
    expect(await isCurrentTenantEventAdmitted({} as never, 101)).toBe(false);
  });
});
