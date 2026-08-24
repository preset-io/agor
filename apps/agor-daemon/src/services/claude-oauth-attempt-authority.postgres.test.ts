/**
 * Cross-replica PostgreSQL proof for durable Claude OAuth sign-in attempts.
 *
 * Two authorities over two independent connection pools stand in for two live
 * daemons; no process-local Map takes part in any assertion below. Compose
 * cannot give the suite genuinely separate daemon processes, so "replica A
 * starts, replica B finishes" is modelled this way.
 *
 * Run with:
 *   AGOR_DB_DIALECT=postgresql \
 *   AGOR_TEST_POSTGRES_URL=postgresql://user:pw@host:5432/db \
 *   pnpm --filter @agor/daemon exec vitest run \
 *     src/services/claude-oauth-attempt-authority.postgres.test.ts
 */

import {
  ClaudeOAuthAttemptRepository,
  claudeOauthAttempts,
  createDatabase,
  createTenantScopedDatabaseProxy,
  executeRaw,
  initializeDatabase,
  isMCPOAuthSecretEnvelope,
  isPostgresDatabase,
  type RawDatabase,
  runWithTenantDatabaseScope,
  sql,
  type TenantScopeAwareDatabase,
  UsersRepository,
} from '@agor/core/db';
import type { ClaudeOAuthAttemptID, UserID } from '@agor/core/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ClaudeOAuthAttemptAuthority,
  fingerprintClaudeOAuthState,
} from './claude-oauth-attempt-authority.js';

const postgresUrl = process.env.AGOR_TEST_POSTGRES_URL;
const usesPostgresSchema = process.env.AGOR_DB_DIALECT === 'postgresql';
const masterSecret = 'claude-oauth-ha-postgres-test-master-secret';

/**
 * state_hash is globally unique — a real state is 32 random bytes, so only a
 * fixture reusing a literal across runs can collide. Salt per run.
 */
const RUN = crypto.randomUUID();
const stateFor = (label: string) => `state-capability-${label}-${RUN}`;

interface TenantSeed {
  tenantId: string;
  userId: UserID;
}

function rowsOf(result: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(result)) return result as Array<Record<string, unknown>>;
  const rows = (result as { rows?: unknown[] } | undefined)?.rows;
  return Array.isArray(rows) ? (rows as Array<Record<string, unknown>>) : [];
}

describe.skipIf(!postgresUrl || !usesPostgresSchema)(
  'Claude OAuth attempt authority (PostgreSQL)',
  () => {
    let rawA: RawDatabase;
    let rawB: RawDatabase;
    let dbA: TenantScopeAwareDatabase;
    let dbB: TenantScopeAwareDatabase;
    /** Replica A. */
    let authorityA: ClaudeOAuthAttemptAuthority;
    /** Replica B — a different process would look exactly like this. */
    let authorityB: ClaudeOAuthAttemptAuthority;

    beforeAll(async () => {
      rawA = createDatabase({ dialect: 'postgresql', url: postgresUrl! });
      rawB = createDatabase({ dialect: 'postgresql', url: postgresUrl! });
      await initializeDatabase(rawA);
      if (!isPostgresDatabase(rawA) || !isPostgresDatabase(rawB)) {
        throw new Error('PostgreSQL test requires PostgreSQL');
      }
      dbA = createTenantScopedDatabaseProxy(rawA, {
        requireScope: true,
        label: 'Claude OAuth daemon A integration test',
      });
      dbB = createTenantScopedDatabaseProxy(rawB, {
        requireScope: true,
        label: 'Claude OAuth daemon B integration test',
      });
      authorityA = new ClaudeOAuthAttemptAuthority(dbA, masterSecret);
      authorityB = new ClaudeOAuthAttemptAuthority(dbB, masterSecret);
    });

    afterAll(async () => {
      await Promise.all([
        (rawA as RawDatabase & { $client: { end: () => Promise<void> } }).$client.end(),
        (rawB as RawDatabase & { $client: { end: () => Promise<void> } }).$client.end(),
      ]);
    });

    async function seed(label: string): Promise<TenantSeed> {
      const tenantId = `claude-oauth-${label}-${crypto.randomUUID()}`;
      return runWithTenantDatabaseScope(dbA, tenantId, async (scoped) => {
        const user = await new UsersRepository(scoped).create({
          email: `${crypto.randomUUID()}@example.test`,
          name: `Claude OAuth ${label}`,
        });
        return { tenantId, userId: user.user_id as UserID };
      });
    }

    const start = (
      authority: ClaudeOAuthAttemptAuthority,
      seeded: TenantSeed,
      label: string,
      delegatedHomeKey: string | null = null
    ) =>
      authority.create({
        tenantId: seeded.tenantId,
        userId: seeded.userId,
        codeVerifier: `pkce-verifier-${label}`,
        state: stateFor(label),
        delegatedHomeKey,
      });

    it('lets replica B finish the attempt replica A started', async () => {
      const seeded = await seed('handoff');
      const attemptId = await start(authorityA, seeded, 'handoff', 'alice');

      // B has never seen this attempt in memory — everything it needs is the row.
      const claim = await authorityB.claimForExchange(
        seeded.tenantId,
        seeded.userId,
        attemptId,
        stateFor('handoff')
      );
      expect(claim.outcome).toBe('claimed');
      if (claim.outcome !== 'claimed') return;

      const opened = authorityB.openClaim(claim.attempt);
      expect(opened.material.codeVerifier).toBe('pkce-verifier-handoff');
      expect(opened.material.delegatedHomeKey).toBe('alice');
      expect(opened.material).not.toHaveProperty('state');

      expect(await authorityB.finish(claim.attempt, 'succeeded', { subscriptionType: 'max' })).toBe(
        true
      );
      const settled = await authorityA.getForUser(seeded.tenantId, seeded.userId, attemptId);
      expect(settled?.status).toBe('succeeded');
      expect(settled?.subscriptionType).toBe('max');
      // Terminal rows retain no exchange material.
      expect(settled?.sealedMaterial).toBeNull();
    });

    it('stores a sealed envelope and the state fingerprint, never the raw secrets', async () => {
      const seeded = await seed('secrets');
      const attemptId = await start(authorityA, seeded, 'secrets');

      const row = await runWithTenantDatabaseScope(dbA, seeded.tenantId, async (scoped) => {
        const result = await executeRaw(
          scoped,
          sql`SELECT * FROM ${claudeOauthAttempts} WHERE attempt_id = ${attemptId}`
        );
        return rowsOf(result)[0];
      });

      expect(isMCPOAuthSecretEnvelope(String(row?.sealed_material))).toBe(true);
      expect(String(row?.sealed_material)).toMatch(/^agor-mcp-oauth:v1:claude-signin-attempt:/);
      expect(row?.state_hash).toBe(fingerprintClaudeOAuthState(stateFor('secrets')));
      const serialized = JSON.stringify(row);
      expect(serialized).not.toContain('pkce-verifier-secrets');
      expect(serialized).not.toContain(stateFor('secrets'));
    });

    it('admits exactly one exchange when both replicas submit the same code', async () => {
      const seeded = await seed('concurrent');
      const attemptId = await start(authorityA, seeded, 'concurrent');

      const [first, second] = await Promise.all([
        authorityA.claimForExchange(
          seeded.tenantId,
          seeded.userId,
          attemptId,
          stateFor('concurrent')
        ),
        authorityB.claimForExchange(
          seeded.tenantId,
          seeded.userId,
          attemptId,
          stateFor('concurrent')
        ),
      ]);

      const claimed = [first, second].filter((r) => r.outcome === 'claimed');
      expect(claimed).toHaveLength(1);
      const loser = [first, second].find((r) => r.outcome !== 'claimed');
      expect(loser?.attempt?.status).toBe('exchanging');
    });

    it('supersedes the previous attempt when a new one starts, and fences the old claim', async () => {
      const seeded = await seed('supersede');
      const firstId = await start(authorityA, seeded, 'supersede-1');
      const claim = await authorityA.claimForExchange(
        seeded.tenantId,
        seeded.userId,
        firstId,
        stateFor('supersede-1')
      );
      expect(claim.outcome).toBe('claimed');
      if (claim.outcome !== 'claimed') return;

      // Replica B issues a fresh link while A is mid-exchange.
      const secondId = await start(authorityB, seeded, 'supersede-2');
      expect(secondId).not.toBe(firstId);

      // A's in-flight claim is no longer live, so its pre-write revalidation
      // fails and it must not write a credential or flip the auth method.
      expect(
        await authorityA.readLiveClaim(seeded.tenantId, firstId, claim.attempt.exchangeClaimId!)
      ).toBeNull();
      expect(await authorityA.finish(claim.attempt, 'succeeded')).toBe(false);

      const superseded = await authorityB.getForUser(seeded.tenantId, seeded.userId, firstId);
      // An exchange that may already have burned the code is ambiguous, not failed.
      expect(superseded?.status).toBe('ambiguous');
      expect(superseded?.failureCode).toBe('superseded_by_newer_attempt');
      expect(superseded?.isCurrent).toBe(false);

      const current = await authorityA.getCurrentForUser(seeded.tenantId, seeded.userId);
      expect(current?.attemptId).toBe(secondId);
    });

    it('fences a logout that lands while an exchange is in flight', async () => {
      const seeded = await seed('logout');
      const attemptId = await start(authorityA, seeded, 'logout');
      const claim = await authorityA.claimForExchange(
        seeded.tenantId,
        seeded.userId,
        attemptId,
        stateFor('logout')
      );
      expect(claim.outcome).toBe('claimed');
      if (claim.outcome !== 'claimed') return;

      // Logout on replica B, after A already reserved the exchange.
      await authorityB.invalidateForUser(seeded.tenantId, seeded.userId, 'signed_out');

      expect(
        await authorityA.readLiveClaim(seeded.tenantId, attemptId, claim.attempt.exchangeClaimId!)
      ).toBeNull();
      expect(await authorityA.finish(claim.attempt, 'succeeded')).toBe(false);
      const settled = await authorityB.getForUser(seeded.tenantId, seeded.userId, attemptId);
      expect(settled?.status).toBe('ambiguous');
      expect(settled?.failureCode).toBe('signed_out');
    });

    it('expires a timed-out attempt and never lets it be replayed', async () => {
      const seeded = await seed('timeout');
      const attemptId = await start(authorityA, seeded, 'timeout');

      await runWithTenantDatabaseScope(dbA, seeded.tenantId, (scoped) =>
        executeRaw(
          scoped,
          sql`UPDATE ${claudeOauthAttempts}
              SET expires_at = CURRENT_TIMESTAMP - INTERVAL '1 second'
              WHERE attempt_id = ${attemptId}`
        )
      );

      const claim = await authorityB.claimForExchange(
        seeded.tenantId,
        seeded.userId,
        attemptId,
        stateFor('timeout')
      );
      expect(claim.outcome).toBe('not_claimed');
      expect(claim.attempt?.status).toBe('expired');
      expect(claim.attempt?.failureCode).toBe('authorization_timed_out');
      expect(claim.attempt?.sealedMaterial).toBeNull();

      // A second submit of the same code finds nothing to replay.
      const replay = await authorityA.claimForExchange(
        seeded.tenantId,
        seeded.userId,
        attemptId,
        stateFor('timeout')
      );
      expect(replay.outcome).toBe('not_claimed');
    });

    it('refuses a claim whose state does not match the attempt', async () => {
      const seeded = await seed('wrong-state');
      const attemptId = await start(authorityA, seeded, 'wrong-state');

      const claim = await authorityB.claimForExchange(
        seeded.tenantId,
        seeded.userId,
        attemptId,
        stateFor('someone-else')
      );
      expect(claim.outcome).toBe('not_claimed');
      // Still claimable with the right state — a wrong paste must not burn it.
      expect(claim.attempt?.status).toBe('pending');
      const good = await authorityB.claimForExchange(
        seeded.tenantId,
        seeded.userId,
        attemptId,
        stateFor('wrong-state')
      );
      expect(good.outcome).toBe('claimed');
    });

    it('refuses a cross-user and a cross-tenant claim of the same attempt', async () => {
      const seeded = await seed('cross-user');
      const other = await seed('cross-user-other');
      const attemptId = await start(authorityA, seeded, 'cross-user');

      // Another user inside the same tenant.
      const crossUser = await authorityB.claimForExchange(
        seeded.tenantId,
        other.userId,
        attemptId,
        stateFor('cross-user')
      );
      expect(crossUser.outcome).toBe('not_claimed');
      expect(crossUser.attempt).toBeNull();

      // Another tenant entirely.
      const crossTenant = await authorityB.claimForExchange(
        other.tenantId,
        seeded.userId,
        attemptId,
        stateFor('cross-user')
      );
      expect(crossTenant.outcome).toBe('not_claimed');
      expect(crossTenant.attempt).toBeNull();

      // Neither read nor claim disturbed the real attempt.
      const untouched = await authorityA.getForUser(seeded.tenantId, seeded.userId, attemptId);
      expect(untouched?.status).toBe('pending');

      // Cross-tenant status reads must not surface the row either.
      expect(await authorityA.getForUser(other.tenantId, seeded.userId, attemptId)).toBeNull();
    });

    it('does not expose default-tenant rows when no tenant GUC is active', async () => {
      const seeded = await runWithTenantDatabaseScope(dbA, 'default', async (scoped) => {
        const user = await new UsersRepository(scoped).create({
          email: `${crypto.randomUUID()}@example.test`,
          name: 'Claude OAuth default tenant RLS',
        });
        return { tenantId: 'default', userId: user.user_id as UserID };
      });
      const attemptId = await start(authorityA, seeded, 'default-no-guc');

      // rawB is the verified NOSUPERUSER/NOBYPASSRLS application handle. With
      // neither tenant nor system scope set, even tenant `default` must be
      // invisible; omission cannot silently become default-tenant authority.
      const result = await executeRaw(
        rawB,
        sql`SELECT COUNT(*) AS visible
            FROM ${claudeOauthAttempts}
            WHERE attempt_id = ${attemptId}`
      );
      expect(Number(rowsOf(result)[0]?.visible)).toBe(0);
    });

    it('fails closed when the master secret is missing or does not match', async () => {
      expect(() => new ClaudeOAuthAttemptAuthority(dbA, undefined)).toThrow(/AGOR_MASTER_SECRET/);

      const seeded = await seed('mixed-secret');
      const attemptId = await start(authorityA, seeded, 'mixed-secret');
      // A replica booted with a different master secret must not be able to
      // open the envelope — it fails rather than exchanging with junk.
      const wrongSecret = new ClaudeOAuthAttemptAuthority(
        dbB,
        'a-different-deployment-secret-32ch'
      );
      const claim = await wrongSecret.claimForExchange(
        seeded.tenantId,
        seeded.userId,
        attemptId,
        stateFor('mixed-secret')
      );
      expect(claim.outcome).toBe('claimed');
      if (claim.outcome !== 'claimed') return;
      expect(() => wrongSecret.openClaim(claim.attempt)).toThrow(/material is unavailable/);
    });

    it('rejects sealed material rebound to a different attempt row', async () => {
      const seeded = await seed('rebind');
      const donorId = await start(authorityA, seeded, 'rebind-donor');
      const donor = await authorityA.getForUser(seeded.tenantId, seeded.userId, donorId);
      // Start a second attempt, then graft the first attempt's ciphertext onto it.
      const targetId = await start(authorityA, seeded, 'rebind-target');
      await runWithTenantDatabaseScope(dbA, seeded.tenantId, (scoped) =>
        executeRaw(
          scoped,
          sql`UPDATE ${claudeOauthAttempts}
              SET sealed_material = ${donor?.sealedMaterial}
              WHERE attempt_id = ${targetId}`
        )
      );

      const claim = await authorityB.claimForExchange(
        seeded.tenantId,
        seeded.userId,
        targetId,
        stateFor('rebind-target')
      );
      expect(claim.outcome).toBe('claimed');
      if (claim.outcome !== 'claimed') return;
      // AAD binds the envelope to its own attempt id and generation.
      expect(() => authorityB.openClaim(claim.attempt)).toThrow(/material is unavailable/);
    });

    it('ages an abandoned exchange to ambiguous during maintenance', async () => {
      const seeded = await seed('maintenance');
      const attemptId = await start(authorityA, seeded, 'maintenance');
      await authorityA.claimForExchange(
        seeded.tenantId,
        seeded.userId,
        attemptId,
        stateFor('maintenance')
      );
      await runWithTenantDatabaseScope(dbA, seeded.tenantId, (scoped) =>
        executeRaw(
          scoped,
          sql`UPDATE ${claudeOauthAttempts}
              SET exchange_started_at = CURRENT_TIMESTAMP - INTERVAL '5 minutes'
              WHERE attempt_id = ${attemptId}`
        )
      );

      await authorityB.maintain();

      const aged = await authorityA.getForUser(seeded.tenantId, seeded.userId, attemptId);
      // The replica that owned the exchange is gone; the daemon cannot know
      // whether Anthropic consumed the code, so this is ambiguous.
      expect(aged?.status).toBe('ambiguous');
      expect(aged?.failureCode).toBe('exchange_owner_lost');
      expect(aged?.sealedMaterial).toBeNull();
    });

    it('keeps one live attempt per user under concurrent starts', async () => {
      const seeded = await seed('one-live');
      await Promise.all([
        start(authorityA, seeded, 'one-live-a'),
        start(authorityB, seeded, 'one-live-b'),
      ]);

      const live = await runWithTenantDatabaseScope(dbA, seeded.tenantId, async (scoped) => {
        const result = await executeRaw(
          scoped,
          sql`SELECT COUNT(*) AS live FROM ${claudeOauthAttempts}
              WHERE tenant_id = ${seeded.tenantId}
                AND user_id = ${seeded.userId}
                AND is_current = true`
        );
        return Number(rowsOf(result)[0]?.live);
      });
      expect(live).toBe(1);
    });

    it('refuses a repository built on a non-tenant scope', async () => {
      const seeded = await seed('scope');
      await expect(
        runWithTenantDatabaseScope(dbA, seeded.tenantId, async (scoped) => {
          const repository = new ClaudeOAuthAttemptRepository(scoped);
          // A lock for a DIFFERENT tenant than the open scope must be refused.
          return repository.allocateAttemptGeneration('some-other-tenant', seeded.userId);
        })
      ).rejects.toThrow(/tenant transaction/);
    });

    it('never returns the verifier or state through the status read path', async () => {
      const seeded = await seed('status-read');
      const attemptId = await start(authorityA, seeded, 'status-read');
      const record = await authorityB.getForUser(
        seeded.tenantId,
        seeded.userId,
        attemptId as ClaudeOAuthAttemptID
      );
      const serialized = JSON.stringify(record);
      expect(serialized).not.toContain('pkce-verifier-status-read');
      expect(serialized).not.toContain(stateFor('status-read'));
    });
  }
);
