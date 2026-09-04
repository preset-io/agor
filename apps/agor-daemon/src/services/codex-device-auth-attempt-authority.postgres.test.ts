/** Two-pool PostgreSQL proof for Codex device attempt ownership/fencing. */

import {
  createDatabase,
  createTenantScopedDatabaseProxy,
  executeRaw,
  initializeDatabase,
  isBoundSecretEnvelope,
  isPostgresDatabase,
  type RawDatabase,
  runWithTenantContext,
  runWithTenantDatabaseScope,
  sql,
  type TenantScopeAwareDatabase,
  UsersRepository,
} from '@agor/core/db';
import type { UserID } from '@agor/core/types';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { writeCodexAuthCredential } from '../utils/executor-codex-auth.js';
import { CodexDeviceAuthAttemptAuthority } from './codex-device-auth-attempt-authority.js';
import { createDurableCodexDeviceAuthService } from './codex-device-auth-durable.js';
import type { CodexDeviceAuthProvider } from './codex-device-auth-provider.js';

vi.mock('../utils/executor-codex-auth.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/executor-codex-auth.js')>();
  return { ...actual, writeCodexAuthCredential: vi.fn() };
});

const writeCodexAuthCredentialMock = vi.mocked(writeCodexAuthCredential);

const postgresUrl = process.env.AGOR_TEST_POSTGRES_URL;
const usesPostgresSchema = process.env.AGOR_DB_DIALECT === 'postgresql';
const masterSecret = 'codex-device-ha-test-master-secret';

describe.skipIf(!postgresUrl || !usesPostgresSchema)(
  'Codex device attempt authority (PostgreSQL)',
  () => {
    let rawA: RawDatabase;
    let rawB: RawDatabase;
    let dbA: TenantScopeAwareDatabase;
    let dbB: TenantScopeAwareDatabase;
    let authorityA: CodexDeviceAuthAttemptAuthority;
    let authorityB: CodexDeviceAuthAttemptAuthority;

    beforeAll(async () => {
      rawA = createDatabase({ dialect: 'postgresql', url: postgresUrl! });
      rawB = createDatabase({ dialect: 'postgresql', url: postgresUrl! });
      await initializeDatabase(rawA);
      if (!isPostgresDatabase(rawA) || !isPostgresDatabase(rawB)) {
        throw new Error('PostgreSQL test requires PostgreSQL');
      }
      dbA = createTenantScopedDatabaseProxy(rawA, {
        requireScope: true,
        label: 'Codex device daemon A test',
      });
      dbB = createTenantScopedDatabaseProxy(rawB, {
        requireScope: true,
        label: 'Codex device daemon B test',
      });
      authorityA = new CodexDeviceAuthAttemptAuthority(dbA, masterSecret);
      authorityB = new CodexDeviceAuthAttemptAuthority(dbB, masterSecret);
    });

    afterAll(async () => {
      await Promise.all([
        (rawA as RawDatabase & { $client: { end: () => Promise<void> } }).$client.end(),
        (rawB as RawDatabase & { $client: { end: () => Promise<void> } }).$client.end(),
      ]);
    });

    async function seed(label: string): Promise<{ tenantId: string; userId: UserID }> {
      const tenantId = `codex-device-${label}-${crypto.randomUUID()}`;
      const userId = await seedUser(tenantId, label);
      return { tenantId, userId };
    }

    async function seedUser(tenantId: string, label: string): Promise<UserID> {
      return runWithTenantDatabaseScope(dbA, tenantId, async (scoped) => {
        const user = await new UsersRepository(scoped).create({
          email: `${crypto.randomUUID()}@example.test`,
          name: `Codex ${label}`,
        });
        return user.user_id as UserID;
      });
    }

    async function pending(label: string) {
      const owner = await seed(label);
      const reserved = await authorityA.reserve({
        ...owner,
        delegatedHomeKey: `home-${label}`,
        codexHome: `/safe/${label}/.codex`,
      });
      const record = await authorityA.attachGrant(reserved, {
        deviceAuthId: `device-${label}`,
        userCode: `CODE-${label}`,
        intervalMs: 2_000,
      });
      if (!record) throw new Error('Expected pending attempt');
      await runWithTenantDatabaseScope(dbA, owner.tenantId, (scoped) =>
        executeRaw(
          scoped,
          sql`UPDATE codex_device_auth_attempts SET poll_next_at = clock_timestamp()
              WHERE attempt_id = ${record.attemptId}`
        ).then(() => undefined)
      );
      return { owner, record };
    }

    it('revalidates a captured route while holding durable reservation authority', async () => {
      const owner = await seed('route-before-reservation');
      await expect(
        authorityA.reserve({
          ...owner,
          delegatedHomeKey: 'retired-home',
          codexHome: '/retired/.codex',
          validateRoute: async () => false,
        })
      ).rejects.toThrow(/route changed/i);
      await expect(authorityA.getCurrentForUser(owner.tenantId, owner.userId)).resolves.toBeNull();
    });

    it('runs the simulated provider flow from service A while service B observes and competes', async () => {
      const owner = await seed('service-flow');
      const idToken = `${Buffer.from('{}').toString('base64url')}.${Buffer.from(
        JSON.stringify({
          'https://api.openai.com/auth': {
            chatgpt_plan_type: 'team',
            chatgpt_account_id: 'account-service-flow',
          },
        })
      ).toString('base64url')}.signature`;
      const requestUserCode = vi.fn(async () => ({
        deviceAuthId: 'device-service-flow',
        userCode: 'FLOW-CODE',
        intervalMs: 2_000,
      }));
      const pollDeviceToken = vi.fn(async () => ({
        outcome: 'approved' as const,
        approved: { authorizationCode: 'authorization-service-flow', codeVerifier: 'verifier' },
      }));
      const exchangeCodeForTokens = vi.fn(async () => ({
        idToken,
        accessToken: 'access-service-flow',
        refreshToken: 'refresh-service-flow',
      }));
      const provider: CodexDeviceAuthProvider = {
        requestUserCode,
        pollDeviceToken,
        exchangeCodeForTokens,
      };
      const usersService = {
        get: vi.fn(async () => ({ agentic_auth_methods: {} })),
        patch: vi.fn(async () => ({})),
      };
      const config = {
        execution: {
          unix_user_mode: 'sandbox',
          executor_storage: { user_home: 'persistent-per-user' },
          // Production config resolution forces these invariants for the
          // named sandbox mode; this direct service fixture supplies the
          // already-resolved shape explicitly.
          sandbox: { enabled: true, home_mode: 'per_user' },
        },
        multi_tenancy: { mode: 'required_from_auth' },
      } as const;
      const app = {
        get: () => config,
        service: () => usersService,
      };
      writeCodexAuthCredentialMock.mockResolvedValueOnce({
        authMode: 'chatgpt',
        planType: 'team',
      });
      const serviceA = createDurableCodexDeviceAuthService(app as never, dbA, authorityA, provider);
      const serviceB = createDurableCodexDeviceAuthService(app as never, dbB, authorityB, provider);
      const params = {
        user: {
          user_id: owner.userId,
          email: 'service-flow@example.test',
          role: 'member',
        },
      } as never;

      const started = await runWithTenantContext(owner.tenantId, () => serviceA.create({}, params));
      expect(started).toMatchObject({ phase: 'pending', userCode: 'FLOW-CODE' });
      expect(String(started)).not.toContain('device-service-flow');

      const throughB = await runWithTenantContext(owner.tenantId, () => serviceB.find(params));
      expect(throughB).toEqual(started);

      const deadline = Date.now() + 6_000;
      let completed = throughB;
      while (completed.phase === 'pending' && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        completed = await runWithTenantContext(owner.tenantId, () => serviceB.find(params));
      }
      expect(completed).toMatchObject({ phase: 'success', planType: 'team' });
      expect(pollDeviceToken).toHaveBeenCalledTimes(1);
      expect(exchangeCodeForTokens).toHaveBeenCalledTimes(1);
      expect(writeCodexAuthCredentialMock).toHaveBeenCalledTimes(1);
      expect(writeCodexAuthCredentialMock).toHaveBeenCalledWith(
        expect.stringContaining('refresh-service-flow'),
        expect.objectContaining({
          userId: owner.userId,
          codexHome: expect.stringContaining(
            `/tenants/${owner.tenantId}/homes/${owner.userId}/.codex`
          ),
        }),
        expect.any(Number)
      );
      expect(JSON.stringify(completed)).not.toContain('service-flow');
      expect(usersService.patch).toHaveBeenCalledTimes(1);
    }, 10_000);

    it('starts on A, reads/claims on B, and seals every provider capability', async () => {
      const { owner, record } = await pending('peer');
      const observed = await authorityB.getCurrentForUser(owner.tenantId, owner.userId);
      expect(observed).toMatchObject({ attemptId: record.attemptId, status: 'pending' });
      expect(isBoundSecretEnvelope(observed!.sealedMaterial!)).toBe(true);
      expect(observed!.sealedMaterial).not.toContain('device-peer');
      expect(observed!.sealedMaterial).not.toContain('CODE-peer');
      expect(authorityB.open(observed!)).toMatchObject({
        tenantId: owner.tenantId,
        userId: owner.userId,
        deviceAuthId: 'device-peer',
        userCode: 'CODE-peer',
      });
    });

    it('rejects stale-route import/logout before invalidating a newer durable attempt', async () => {
      const { owner, record } = await pending('stale-mutation-preflight');
      const work = vi.fn(async () => undefined);

      await expect(
        authorityB.runCredentialMutation(
          owner.tenantId,
          owner.userId,
          'credentials_imported',
          work,
          async () => {
            throw new Error('retired route');
          }
        )
      ).rejects.toThrow(/retired route/);

      expect(work).not.toHaveBeenCalled();
      await expect(
        authorityA.getCurrentForUser(owner.tenantId, owner.userId)
      ).resolves.toMatchObject({ attemptId: record.attemptId, status: 'pending', isCurrent: true });
    });

    it('admits one poll owner, permits bounded takeover, and rejects the stale owner', async () => {
      const { record } = await pending('takeover');
      const [claimA, claimB] = await Promise.all([
        authorityA.claimPoll(record, 25_000),
        authorityB.claimPoll(record, 25_000),
      ]);
      const winner = claimA ?? claimB;
      expect([claimA, claimB].filter(Boolean)).toHaveLength(1);
      expect(winner).not.toBeNull();

      // Advance the durable lease boundary directly instead of assuming two
      // independent pools will both finish inside a 100 ms wall-clock window.
      // Under CI load the first UPDATE can legitimately return after that tiny
      // test lease has expired, allowing the peer's otherwise-correct takeover
      // before Promise.all observes either result.
      await runWithTenantDatabaseScope(dbA, record.tenantId, (scoped) =>
        executeRaw(
          scoped,
          sql`UPDATE codex_device_auth_attempts
              SET poll_lease_expires_at = clock_timestamp() - INTERVAL '1 millisecond'
              WHERE tenant_id = ${record.tenantId}
                AND attempt_id = ${record.attemptId}
                AND poll_claim_id = ${winner!.pollClaimId}
                AND poll_claim_generation = ${winner!.pollClaimGeneration}`
        ).then(() => undefined)
      );
      const takeover = await (claimA ? authorityB : authorityA).claimPoll(record, 25_000);
      expect(takeover).toMatchObject({
        attemptId: record.attemptId,
        pollClaimGeneration: winner!.pollClaimGeneration + 1,
      });
      await expect(authorityA.recordPending(winner!, 2_000)).resolves.toBe(false);
      await expect(authorityB.recordPending(takeover!, 2_000)).resolves.toBe(true);
    });

    it('claims an approved exchange exactly once and generation-fences replacement', async () => {
      const { owner, record } = await pending('exchange');
      const poll = await authorityA.claimPoll(record, 2_000);
      if (!poll) throw new Error('Expected poll claim');
      const [exchangeA, exchangeB] = await Promise.all([
        authorityA.claimExchange(poll),
        authorityB.claimExchange(poll),
      ]);
      const exchange = exchangeA ?? exchangeB;
      expect([exchangeA, exchangeB].filter(Boolean)).toHaveLength(1);

      const newer = await authorityB.reserve({
        ...owner,
        delegatedHomeKey: 'new-home',
      });
      expect(newer.record.attemptGeneration).toBeGreaterThan(record.attemptGeneration);
      await expect(
        authorityA.failExchange(exchange!, 'failed', 'stale_exchange_must_not_finish')
      ).resolves.toBe(false);
      await expect(
        authorityA.getCurrentForUser(owner.tenantId, owner.userId)
      ).resolves.toMatchObject({ attemptId: newer.record.attemptId, status: 'starting' });
      let staleWorkCalls = 0;
      await expect(
        authorityA.finalize(exchange!, async () => {
          staleWorkCalls += 1;
          return { value: undefined };
        })
      ).resolves.toEqual({ outcome: 'stale' });
      expect(staleWorkCalls).toBe(0);
    });

    it('runs duplicate completion callbacks once behind the user generation fence', async () => {
      const { owner, record } = await pending('completion');
      const poll = await authorityA.claimPoll(record, 2_000);
      if (!poll) throw new Error('Expected poll claim');
      const exchange = await authorityA.claimExchange(poll);
      if (!exchange) throw new Error('Expected exchange claim');
      let workCalls = 0;
      const work = async () => {
        workCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 25));
        return { value: 'saved', planType: 'plus' };
      };

      const outcomes = await Promise.all([
        authorityA.finalize(exchange, work),
        authorityB.finalize(exchange, work),
      ]);
      expect(workCalls).toBe(1);
      expect(outcomes.filter((outcome) => outcome.outcome === 'committed')).toHaveLength(1);
      expect(outcomes.filter((outcome) => outcome.outcome === 'stale')).toHaveLength(1);
      await expect(
        authorityB.getCurrentForUser(owner.tenantId, owner.userId)
      ).resolves.toMatchObject({ status: 'succeeded', planType: 'plus', sealedMaterial: null });

      let logoutGeneration = 0;
      await authorityB.runCredentialMutation(
        owner.tenantId,
        owner.userId,
        'credentials_removed',
        async (generation) => {
          logoutGeneration = generation;
        }
      );
      expect(logoutGeneration).toBeGreaterThan(record.attemptGeneration);
      await expect(authorityA.getCurrentForUser(owner.tenantId, owner.userId)).resolves.toBeNull();
      const reauth = await authorityA.reserve({ ...owner, delegatedHomeKey: 'reauth-home' });
      expect(reauth.record.attemptGeneration).toBeGreaterThan(logoutGeneration);
    });

    it('isolates exact tenant + user and rejects ciphertext swapping', async () => {
      const first = await pending('owner');
      const attacker = await seed('attacker');
      await expect(
        authorityB.getCurrentForUser(attacker.tenantId, attacker.userId)
      ).resolves.toBeNull();
      const sameTenantPeer = await seedUser(first.owner.tenantId, 'same-tenant-peer');
      await expect(
        authorityB.getCurrentForUser(first.owner.tenantId, sameTenantPeer)
      ).resolves.toBeNull();

      const second = await pending('second');
      await runWithTenantDatabaseScope(dbA, second.owner.tenantId, (scoped) =>
        executeRaw(
          scoped,
          sql`UPDATE codex_device_auth_attempts
              SET sealed_material = ${first.record.sealedMaterial}
              WHERE attempt_id = ${second.record.attemptId}`
        ).then(() => undefined)
      );
      const tampered = await authorityB.getCurrentForUser(
        second.owner.tenantId,
        second.owner.userId
      );
      expect(() => authorityB.open(tampered!)).toThrow(/unavailable|binding/);
    });

    it('serializes cancel/new-attempt races under one user authority lock', async () => {
      const { owner, record } = await pending('cancel');
      const [, next] = await Promise.all([
        authorityA.cancel(owner.tenantId, owner.userId, record.attemptId),
        authorityB.reserve({ ...owner, delegatedHomeKey: 'after-cancel' }),
      ]);
      const current = await authorityA.getCurrentForUser(owner.tenantId, owner.userId);
      // Ordering is intentionally whichever got the DB lock first. The result
      // is deterministic for that order: either no current attempt (cancel won
      // second), or exactly the newly reserved generation (reserve won second).
      expect(current === null || current.attemptId === next.record.attemptId).toBe(true);
      const rows = await runWithTenantDatabaseScope(dbA, owner.tenantId, async (scoped) => {
        const result = await executeRaw(
          scoped,
          sql`SELECT count(*) AS count FROM codex_device_auth_attempts
              WHERE user_id = ${owner.userId} AND is_current = true`
        );
        const raw = result as { rows?: Array<{ count: string }> };
        return Number(raw.rows?.[0]?.count ?? 0);
      });
      expect(rows).toBeLessThanOrEqual(1);
    });

    it('does not let a stale UI cancel a newer attempt', async () => {
      const { owner, record } = await pending('stale-cancel');
      const newer = await authorityB.reserve({ ...owner, delegatedHomeKey: 'newer-home' });
      await expect(authorityA.cancel(owner.tenantId, owner.userId, record.attemptId)).resolves.toBe(
        0
      );
      await expect(
        authorityA.getCurrentForUser(owner.tenantId, owner.userId)
      ).resolves.toMatchObject({ attemptId: newer.record.attemptId, status: 'starting' });
    });

    it('does not relabel a credential that completed before cancellation acquired the lock', async () => {
      const { owner, record } = await pending('cancel-after-complete');
      const poll = await authorityA.claimPoll(record, 2_000);
      if (!poll) throw new Error('Expected poll claim');
      const exchange = await authorityA.claimExchange(poll);
      if (!exchange) throw new Error('Expected exchange claim');
      await expect(
        authorityA.finalize(exchange, async () => ({ value: undefined }))
      ).resolves.toEqual({ outcome: 'committed', value: undefined });

      await expect(authorityB.cancel(owner.tenantId, owner.userId, record.attemptId)).resolves.toBe(
        0
      );
      await expect(
        authorityB.getCurrentForUser(owner.tenantId, owner.userId)
      ).resolves.toMatchObject({ attemptId: record.attemptId, status: 'succeeded' });
    });

    it('uses the narrow system capability to expire due attempts under forced RLS', async () => {
      const { owner, record } = await pending('maintenance');
      await runWithTenantDatabaseScope(dbA, owner.tenantId, (scoped) =>
        executeRaw(
          scoped,
          sql`UPDATE codex_device_auth_attempts
              SET expires_at = clock_timestamp() - INTERVAL '1 second'
              WHERE attempt_id = ${record.attemptId}`
        ).then(() => undefined)
      );

      await expect(authorityB.maintain()).resolves.toMatchObject({ expired: 1 });
      await expect(
        authorityA.getCurrentForUser(owner.tenantId, owner.userId)
      ).resolves.toMatchObject({ status: 'expired', sealedMaterial: null });
    });
  }
);
