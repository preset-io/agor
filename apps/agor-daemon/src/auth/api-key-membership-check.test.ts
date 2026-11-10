import {
  createDatabase,
  createTenantScopedDatabaseProxy,
  getCurrentTenantDatabaseScope,
  runWithTenantDatabaseScope,
  runWithTenantDatabaseTransaction,
} from '@agor/core/db';
import { NotAuthenticated, Unavailable } from '@agor/core/feathers';
import type { UserID } from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
import {
  API_KEY_MEMBERSHIP_CHECK_INTERVAL_MS,
  API_KEY_MEMBERSHIP_MAX_TRACKED_USERS,
  API_KEY_MEMBERSHIP_RETRY_MS,
  createApiKeyMembershipCheck,
} from './api-key-membership-check.js';
import { LaunchMembershipRefusedError, type LaunchSessionRevalidator } from './launch-auth.js';
import { AUTH_LAUNCH_SUBJECT_CLAIM, AUTH_REVALIDATED_AT_MS_CLAIM } from './session-lifetime.js';

const userId = 'user-1' as UserID;
const tenantId = 'tenant-a';
const confirmed = (atMs: number) => ({ launchSubject: 'user:1', revalidatedAtMs: atMs });

function harness(revalidate: ReturnType<typeof vi.fn>) {
  const clock = { nowMs: 1_000_000 };
  const check = createApiKeyMembershipCheck({
    revalidate: revalidate as unknown as LaunchSessionRevalidator,
    now: () => clock.nowMs,
  });
  return { clock, check };
}

describe('API key membership check', () => {
  it('asks the issuer once per interval and passes the tenant and last confirmation', async () => {
    const revalidate = vi.fn(async () => confirmed(1_000_000));
    const { clock, check } = harness(revalidate);

    await expect(check({ tenantId, userId })).resolves.toBe('allowed');
    clock.nowMs += API_KEY_MEMBERSHIP_CHECK_INTERVAL_MS - 1;
    await expect(check({ tenantId, userId })).resolves.toBe('allowed');
    expect(revalidate).toHaveBeenCalledTimes(1);
    expect(revalidate.mock.calls[0][0]).toEqual({
      userId,
      payload: { sub: userId, tenant_id: tenantId },
    });

    clock.nowMs += 1;
    await check({ tenantId, userId });
    expect(revalidate).toHaveBeenCalledTimes(2);
    expect(revalidate.mock.calls[1][0].payload[AUTH_REVALIDATED_AT_MS_CLAIM]).toBe(1_000_000);
    expect(revalidate.mock.calls[1][0].payload[AUTH_LAUNCH_SUBJECT_CLAIM]).toBe('user:1');
  });

  it('remembers an account with no launch identity for the interval', async () => {
    const revalidate = vi.fn(async () => null);
    const { check } = harness(revalidate);
    await expect(check({ tenantId, userId })).resolves.toBe('allowed');
    await expect(check({ tenantId, userId })).resolves.toBe('allowed');
    expect(revalidate).toHaveBeenCalledTimes(1);
  });

  it('rejects after a refusal and asks again only after a full interval', async () => {
    const revalidate = vi.fn(async () => {
      throw new LaunchMembershipRefusedError('refused');
    });
    const { clock, check } = harness(revalidate);
    await expect(check({ tenantId, userId })).resolves.toBe('rejected');
    clock.nowMs += API_KEY_MEMBERSHIP_CHECK_INTERVAL_MS - 1;
    await expect(check({ tenantId, userId })).resolves.toBe('rejected');
    expect(revalidate).toHaveBeenCalledTimes(1);
    clock.nowMs += 1;
    await check({ tenantId, userId });
    expect(revalidate).toHaveBeenCalledTimes(2);
  });

  it('stays rejected when an outage follows a refusal, until the issuer answers', async () => {
    const revalidate = vi
      .fn()
      .mockRejectedValueOnce(new LaunchMembershipRefusedError('refused'))
      .mockRejectedValueOnce(new Unavailable('down'))
      .mockResolvedValue(confirmed(1_000_000));
    const { clock, check } = harness(revalidate);
    await check({ tenantId, userId });
    clock.nowMs += API_KEY_MEMBERSHIP_CHECK_INTERVAL_MS;
    await expect(check({ tenantId, userId })).resolves.toBe('rejected');
    clock.nowMs += API_KEY_MEMBERSHIP_RETRY_MS;
    await expect(check({ tenantId, userId })).resolves.toBe('allowed');
  });

  it('drops the remembered confirmation after a rejection', async () => {
    const revalidate = vi
      .fn()
      .mockResolvedValueOnce(confirmed(1_000_000))
      .mockRejectedValueOnce(new LaunchMembershipRefusedError('refused'))
      .mockResolvedValue(confirmed(1_000_000));
    const { clock, check } = harness(revalidate);
    await check({ tenantId, userId });
    clock.nowMs += API_KEY_MEMBERSHIP_CHECK_INTERVAL_MS;
    await check({ tenantId, userId });
    clock.nowMs += API_KEY_MEMBERSHIP_CHECK_INTERVAL_MS;
    await check({ tenantId, userId });
    expect(revalidate.mock.calls[2][0].payload).not.toHaveProperty(AUTH_REVALIDATED_AT_MS_CLAIM);
  });

  it('treats a bad issuer response as a short rejection that keeps the confirmation', async () => {
    const revalidate = vi
      .fn()
      .mockResolvedValueOnce(confirmed(1_000_000))
      .mockRejectedValueOnce(new NotAuthenticated('assertion rejected'))
      .mockResolvedValueOnce({ ...confirmed(1_000_000), notAfterSeconds: 9_000_000 });
    const { clock, check } = harness(revalidate);
    await check({ tenantId, userId });
    clock.nowMs += API_KEY_MEMBERSHIP_CHECK_INTERVAL_MS;
    await expect(check({ tenantId, userId })).resolves.toBe('rejected');
    clock.nowMs += API_KEY_MEMBERSHIP_RETRY_MS - 1;
    await expect(check({ tenantId, userId })).resolves.toBe('rejected');
    expect(revalidate).toHaveBeenCalledTimes(2);
    clock.nowMs += 1;
    await expect(check({ tenantId, userId })).resolves.toBe('allowed');
    expect(revalidate.mock.calls[2][0].payload[AUTH_REVALIDATED_AT_MS_CLAIM]).toBe(1_000_000);
  });

  it('keeps the last confirmation through an outage and caps a deferral at the grace deadline', async () => {
    const start = 1_000_000;
    const deferredAt = start + API_KEY_MEMBERSHIP_CHECK_INTERVAL_MS;
    const deadlineSeconds = Math.floor(deferredAt / 1000) + 30;
    const revalidate = vi
      .fn()
      .mockResolvedValueOnce(confirmed(start))
      .mockResolvedValueOnce({ ...confirmed(start), notAfterSeconds: deadlineSeconds })
      .mockRejectedValue(new Unavailable('down'));
    const { clock, check } = harness(revalidate);
    await check({ tenantId, userId });

    clock.nowMs = deferredAt;
    await expect(check({ tenantId, userId })).resolves.toBe('allowed');
    expect(revalidate.mock.calls[1][0].payload[AUTH_REVALIDATED_AT_MS_CLAIM]).toBe(start);

    // The deadline comes before the usual retry delay, so it decides the next check.
    clock.nowMs = deadlineSeconds * 1000 - 1;
    await expect(check({ tenantId, userId })).resolves.toBe('allowed');
    expect(revalidate).toHaveBeenCalledTimes(2);

    clock.nowMs = deadlineSeconds * 1000;
    await expect(check({ tenantId, userId })).resolves.toBe('unavailable');
    expect(revalidate).toHaveBeenCalledTimes(3);
    expect(revalidate.mock.calls[2][0].payload[AUTH_REVALIDATED_AT_MS_CLAIM]).toBe(start);
  });

  it('reports unavailable with no prior confirmation and does not retry on every request', async () => {
    const revalidate = vi.fn(async () => {
      throw new Unavailable('down');
    });
    const { check } = harness(revalidate);
    await expect(check({ tenantId, userId })).resolves.toBe('unavailable');
    await expect(check({ tenantId, userId })).resolves.toBe('unavailable');
    expect(revalidate).toHaveBeenCalledTimes(1);
  });

  it('shares one issuer call between concurrent requests for a user', async () => {
    let release: (value: ReturnType<typeof confirmed>) => void = () => undefined;
    const revalidate = vi.fn(
      () => new Promise<ReturnType<typeof confirmed>>((resolve) => (release = resolve))
    );
    const { check } = harness(revalidate);
    const requests = [check({ tenantId, userId }), check({ tenantId, userId })];
    release(confirmed(1_000_000));
    await expect(Promise.all(requests)).resolves.toEqual(['allowed', 'allowed']);
    expect(revalidate).toHaveBeenCalledTimes(1);
  });

  it('keeps tenants apart when the same user id exists in both', async () => {
    const revalidate = vi.fn(async ({ payload }: { payload: { tenant_id?: string } }) => {
      if (payload.tenant_id === 'tenant-b') throw new NotAuthenticated('refused');
      return confirmed(1_000_000);
    });
    const { check } = harness(revalidate);
    await expect(check({ tenantId: 'tenant-a', userId })).resolves.toBe('allowed');
    await expect(check({ tenantId: 'tenant-b', userId })).resolves.toBe('rejected');
    await expect(check({ tenantId: 'tenant-a', userId })).resolves.toBe('allowed');
    expect(revalidate).toHaveBeenCalledTimes(2);
  });

  it('evicts the stalest user past its bound', async () => {
    const revalidate = vi.fn(async () => confirmed(1_000_000));
    const { check } = harness(revalidate);
    for (let i = 0; i <= API_KEY_MEMBERSHIP_MAX_TRACKED_USERS; i++) {
      await check({ tenantId, userId: `user-${i}` as UserID });
    }
    const calls = revalidate.mock.calls.length;
    await check({ tenantId, userId: `user-${API_KEY_MEMBERSHIP_MAX_TRACKED_USERS}` as UserID });
    expect(revalidate).toHaveBeenCalledTimes(calls);
    await check({ tenantId, userId: 'user-0' as UserID });
    expect(revalidate).toHaveBeenCalledTimes(calls + 1);
  });

  it('runs outside any ambient request database scope', async () => {
    const db = createTenantScopedDatabaseProxy(createDatabase({ url: ':memory:' }));
    const revalidate = vi.fn(async () => {
      expect(getCurrentTenantDatabaseScope()).toBeUndefined();
      return confirmed(1_000_000);
    });
    const { check } = harness(revalidate);
    await runWithTenantDatabaseScope(db, tenantId, async () => {
      expect(getCurrentTenantDatabaseScope()).toBeDefined();
      await expect(check({ tenantId, userId })).resolves.toBe('allowed');
    });
    expect(revalidate).toHaveBeenCalledTimes(1);
  });

  describe('inside a request transaction', () => {
    const db = createTenantScopedDatabaseProxy(createDatabase({ url: ':memory:' }));
    const inTransaction = <T>(work: () => Promise<T>) =>
      runWithTenantDatabaseTransaction(db, tenantId, async () => {
        expect(getCurrentTenantDatabaseScope()).toMatchObject({ transactionActive: true });
        return work();
      });

    it('never waits for the issuer, and applies the answer to the next request', async () => {
      let refuse: (error: Error) => void = () => undefined;
      const revalidate = vi.fn(() => new Promise((_resolve, reject) => (refuse = reject)));
      const { check } = harness(revalidate);
      await expect(inTransaction(() => check({ tenantId, userId }))).resolves.toBe('allowed');
      await expect(inTransaction(() => check({ tenantId, userId }))).resolves.toBe('allowed');
      expect(revalidate).toHaveBeenCalledTimes(1);
      refuse(new NotAuthenticated('refused'));
      await vi.waitFor(async () =>
        expect(await inTransaction(() => check({ tenantId, userId }))).toBe('rejected')
      );
    });

    it('keeps a known failure closed while the next check runs', async () => {
      const revalidate = vi
        .fn()
        .mockRejectedValueOnce(new Unavailable('down'))
        .mockReturnValue(new Promise(() => undefined));
      const { clock, check } = harness(revalidate);
      await check({ tenantId, userId });
      clock.nowMs += API_KEY_MEMBERSHIP_RETRY_MS;
      await expect(inTransaction(() => check({ tenantId, userId }))).resolves.toBe('unavailable');
      expect(revalidate).toHaveBeenCalledTimes(2);
    });
  });
});
