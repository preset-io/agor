import { createDatabase, runWithTenantContext, TenantRestrictedError } from '@agor/core/db';
import { describe, expect, it, vi } from 'vitest';
import {
  assertRuntimeTenantAccess,
  gatewayOccurrenceTime,
  isCurrentTenantEventAdmitted,
  isTenantRestrictedRejection,
} from './tenant-access.js';

const { assertAccess, postgres, readBoundary } = vi.hoisted(() => ({
  assertAccess: vi.fn(),
  postgres: vi.fn(),
  readBoundary: vi.fn(),
}));
vi.mock('@agor/core/db', async (original) => ({
  ...(await original<typeof import('@agor/core/db')>()),
  assertTenantUnrestricted: assertAccess,
  readTenantExecutionBoundary: readBoundary,
  isPostgresDatabaseHandle: postgres,
}));

describe('tenant access error boundary', () => {
  it('preserves standalone SQLite without claiming restriction support', async () => {
    postgres.mockReturnValueOnce(false);
    assertAccess.mockClear();
    await expect(
      assertRuntimeTenantAccess(createDatabase({ url: ':memory:' }), 'default')
    ).resolves.toBeUndefined();
    expect(assertAccess).not.toHaveBeenCalled();
  });
  it.each([new Error('private database address'), new Error('invalid controller private-id')])(
    'fails closed without exposing backend diagnostics',
    async (error) => {
      postgres.mockReturnValueOnce(true);
      assertAccess.mockRejectedValueOnce(error);
      await expect(assertRuntimeTenantAccess({} as never, 'tenant-a')).rejects.toMatchObject({
        code: 503,
        message: 'Tenant access cannot be verified',
      });
    }
  );
  it('maps installed restriction to a neutral denial with a stable client code', async () => {
    postgres.mockReturnValueOnce(true);
    assertAccess.mockRejectedValueOnce(new TenantRestrictedError());
    const denial = await assertRuntimeTenantAccess({} as never, 'tenant-a').catch((error) => error);
    expect(denial).toMatchObject({
      code: 403,
      message: 'Tenant access is restricted',
      data: { code: 'tenant_restricted' },
    });
    // The code is the entire disclosure: no controller, placement, revision or
    // phase may ride along to the browser.
    expect(Object.keys(denial.data)).toEqual(['code']);
    expect(isTenantRestrictedRejection(denial)).toBe(true);
  });

  it('does not report an unverifiable read as a restriction', async () => {
    postgres.mockReturnValueOnce(true);
    assertAccess.mockRejectedValueOnce(new Error('connection reset'));
    const failure = await assertRuntimeTenantAccess({} as never, 'tenant-a').catch(
      (error) => error
    );
    expect(failure).toMatchObject({ code: 503 });
    expect(isTenantRestrictedRejection(failure)).toBe(false);
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
  postgres.mockReturnValue(true);
  readBoundary.mockResolvedValue({ allowed: true, resumeAfter: 100 });
  await runWithTenantContext('tenant-a', async () => {
    for (const at of [0, 100, NaN])
      expect(await isCurrentTenantEventAdmitted({} as never, at)).toBe(false);
    expect(await isCurrentTenantEventAdmitted({} as never, 101)).toBe(true);
    readBoundary.mockResolvedValue({ allowed: false, resumeAfter: 100 });
    expect(await isCurrentTenantEventAdmitted({} as never, 101)).toBe(false);
  });
});
