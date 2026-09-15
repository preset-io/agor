import { createHash, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ManagedMCPOAuthOperationError } from '../tools/mcp/managed-oauth-client';
import { refreshAndPersistToken } from '../tools/mcp/oauth-refresh';
import type { MCPOAuthAttemptID } from '../types';
import type { McpOAuthOperationResponse } from '../types/mcp-managed-oauth-contract';
import { createDatabase, type Database } from './client';
import { executeRaw, rawRows } from './database-wrapper';
import { MCPOAuthPendingFlowRepository } from './repositories/mcp-oauth-pending-flows';
import { UserMCPOAuthTokenRepository } from './repositories/user-mcp-oauth-tokens';
import { runWithTenantDatabaseScope } from './tenant-scope';
import { managedCommit, seedManagedRefreshGrant } from './test-support/managed-oauth-fixture';
import { createOwnedPostgres, type OwnedPostgres } from './test-support/owned-postgres';

const master = 'synthetic-durable-retry-master';
describe.skipIf(process.env.AGOR_DB_DIALECT !== 'postgresql')(
  'managed retry floor (real non-owner)',
  () => {
    let owned: OwnedPostgres;
    const originalMaster = process.env.AGOR_MASTER_SECRET;
    beforeAll(async () => {
      owned = await createOwnedPostgres();
      process.env.AGOR_MASTER_SECRET = master;
    }, 120000);
    afterAll(async () => {
      await owned?.dispose();
      if (originalMaster === undefined) delete process.env.AGOR_MASTER_SECRET;
      else process.env.AGOR_MASTER_SECRET = originalMaster;
    }, 30000);
    async function fixture() {
      const f = await seedManagedRefreshGrant(owned.db, master);
      const work = <T>(db: Database, fn: (r: UserMCPOAuthTokenRepository) => Promise<T>) =>
        runWithTenantDatabaseScope(db, f.tenant, (tx) =>
          fn(new UserMCPOAuthTokenRepository(tx, master))
        );
      const claim = await work(owned.db, (r) => r.claimRefresh(f.user, f.server, f.expected));
      if (claim.outcome !== 'claimed') throw new Error('fixture claim');
      const start = claim.token.refresh_claimed_at!.getTime();
      const rejection: McpOAuthOperationResponse = {
        protocol_version: 1,
        status: 'rejected_non_consuming',
        failure_code: 'provider_rate_limited',
        operation_id: claim.token.managed_operation_id!,
        owner: f.owner,
        claim: {
          kind: 'refresh',
          claim_id: claim.claimId,
          claimed_at: start,
          deadline_at: start + 120000,
          refresh_generation: String(claim.refreshGeneration),
          refresh_success_generation: '0',
        },
        sequence: '1',
        next_sequence: '2',
        retry_after_ms: 300000,
      };
      const read = () =>
        runWithTenantDatabaseScope(
          owned.peer,
          f.tenant,
          async (db) =>
            rawRows(
              await executeRaw(
                db,
                sql`
   SELECT managed_refresh_not_before, extract(epoch FROM (managed_refresh_not_before-clock_timestamp()))*1000 AS remaining,
    refresh_generation,managed_metadata FROM public.user_mcp_oauth_tokens WHERE user_id=${f.user} AND mcp_server_id=${f.server}`
              )
            )[0]
        );
      return { ...f, work, claim, rejection, read };
    }
    it('persists recovered rejection once across two pools and uses DB time rather than the process clock', async () => {
      const f = await fixture();
      const execute = vi.fn(async ({ recoveryOnly }: { recoveryOnly: boolean }) => {
        expect(recoveryOnly).toBe(true);
        throw new ManagedMCPOAuthOperationError(f.rejection);
      });
      await expect(
        refreshAndPersistToken({
          db: owned.peer,
          tenantId: f.tenant,
          userId: f.user,
          mcpServerId: f.server,
          observedRefreshVersion: f.expected,
          validateGrant: () => true,
          managed: { execute, acknowledge: async () => {} },
        })
      ).rejects.toBeInstanceOf(ManagedMCPOAuthOperationError);
      expect(execute).toHaveBeenCalledTimes(1);
      const before = await f.read();
      expect(Number(before.remaining)).toBeGreaterThan(290000);
      expect(Number(before.remaining)).toBeLessThanOrEqual(300000);
      expect(before.managed_metadata).toMatchObject({
        next_sequence: '2',
        use_authorization: f.commit.metadata.use_authorization,
      });
      expect(
        await f.work(owned.db, (r) =>
          r.finishManagedRefreshRejection(f.user, f.server, f.claim, f.rejection)
        )
      ).toBe(false);
      expect((await f.read()).managed_refresh_not_before).toEqual(
        before.managed_refresh_not_before
      );
      const version = { ...f.expected, refreshGeneration: f.claim.refreshGeneration };
      const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 86400000);
      try {
        const results = await Promise.all(
          [owned.db, owned.peer].map((db) =>
            f.work(db, (r) => r.claimRefresh(f.user, f.server, version))
          )
        );
        expect(results.map((r) => r.outcome)).toEqual(['observed', 'observed']);
      } finally {
        clock.mockRestore();
      }
      expect(Number((await f.read()).refresh_generation)).toBe(f.claim.refreshGeneration);
      // Fixture advances only the persisted DB deadline; there is no process-sleep authority.
      await runWithTenantDatabaseScope(owned.db, f.tenant, (db) =>
        executeRaw(
          db,
          sql`UPDATE public.user_mcp_oauth_tokens
   SET managed_refresh_not_before=clock_timestamp()-interval '1 second' WHERE user_id=${f.user} AND mcp_server_id=${f.server}`
        )
      );
      const next = await f.work(owned.peer, (r) => r.claimRefresh(f.user, f.server, version));
      if (next.outcome !== 'claimed') throw new Error('elapsed floor did not admit');
      expect(next.token.managed_metadata?.next_sequence).toBe('2');
      const start = next.token.refresh_claimed_at!.getTime();
      const commit = managedCommit(
        f.owner,
        {
          kind: 'refresh',
          claim_id: next.claimId,
          claimed_at: start,
          deadline_at: start + 120000,
          refresh_generation: String(next.refreshGeneration),
          refresh_success_generation: '0',
        },
        '2'
      );
      commit.metadata.transaction_id = f.commit.metadata.transaction_id;
      expect(
        await f.work(owned.peer, (r) =>
          r.completeClaimedRefresh(f.user, f.server, next, {
            accessToken: commit.tokens.access_token,
            refreshToken: commit.tokens.refresh_token,
            expiresAt: new Date(commit.tokens.expires_at),
            managed: commit,
          })
        )
      ).toBe(true);
      expect((await f.read()).managed_refresh_not_before).toBeNull();
      expect((await f.read()).managed_metadata).toMatchObject({ next_sequence: '3' });
      expect(
        await f.work(owned.db, (r) =>
          r.finishManagedRefreshRejection(f.user, f.server, f.claim, f.rejection)
        )
      ).toBe(false);
      expect((await f.read()).managed_refresh_not_before).toBeNull();
    });
    it('preserves the floor across non-consuming claim completion and admits a zero delay without process waiting', async () => {
      const f = await fixture();
      if (f.rejection.status !== 'rejected_non_consuming') throw new Error('fixture rejection');
      expect(
        await f.work(owned.db, (r) =>
          r.finishManagedRefreshRejection(f.user, f.server, f.claim, {
            ...f.rejection,
            retry_after_ms: 0,
          })
        )
      ).toBe(true);
      const floor = (await f.read()).managed_refresh_not_before;
      expect(floor).not.toBeNull();
      const next = await f.work(owned.peer, (r) =>
        r.claimRefresh(f.user, f.server, {
          ...f.expected,
          refreshGeneration: f.claim.refreshGeneration,
        })
      );
      if (next.outcome !== 'claimed') throw new Error('zero floor not admitted');
      const start = next.token.refresh_claimed_at!.getTime();
      expect(
        await f.work(owned.peer, (r) =>
          r.finishManagedRefreshRejection(f.user, f.server, next, {
            protocol_version: 1,
            operation_id: next.token.managed_operation_id!,
            owner: f.owner,
            claim: {
              kind: 'refresh',
              claim_id: next.claimId,
              claimed_at: start,
              deadline_at: start + 120000,
              refresh_generation: String(next.refreshGeneration),
              refresh_success_generation: '0',
            },
            status: 'client_configuration_failed',
            failure_code: 'client_configuration_failed',
            sequence: '2',
            next_sequence: '3',
          })
        )
      ).toBe(true);
      expect((await f.read()).managed_refresh_not_before).toEqual(floor);
      expect((await f.read()).managed_metadata).toMatchObject({
        next_sequence: '3',
        use_authorization: f.commit.metadata.use_authorization,
      });
    });
    it('clears the floor only when a new exact grant replaces the old authority', async () => {
      const f = await fixture();
      expect(
        await f.work(owned.db, (r) =>
          r.finishManagedRefreshRejection(f.user, f.server, f.claim, f.rejection)
        )
      ).toBe(true);
      await runWithTenantDatabaseScope(owned.peer, f.tenant, async (db) => {
        const pending = new MCPOAuthPendingFlowRepository(db);
        const subject = {
          tenantId: f.tenant,
          userId: f.user,
          mcpServerId: f.server,
          oauthMode: 'per_user' as const,
          subjectUserId: f.user,
        };
        const generation = await pending.allocateGrantGeneration(subject);
        const attempt = randomUUID() as MCPOAuthAttemptID;
        const transaction = randomUUID();
        const owner = { ...f.owner, attempt_id: attempt, grant_generation: String(generation) };
        await pending.create({
          ...subject,
          attemptId: attempt,
          grantGeneration: generation,
          stateHash: createHash('sha256')
            .update(`agor-mcp-managed-v1\0${transaction}`)
            .digest('hex'),
          configFingerprintVersion: 5,
          configFingerprint: owner.config_fingerprint,
          envelopeVersion: 1,
          sealedMaterial: 'synthetic-new-grant',
          ttlMs: 600000,
          managedTransactionId: transaction,
          managedMetadata: {
            owner,
            cancel_epoch: '0',
            prepare_request: {
              protocol_version: 1,
              operation_id: randomUUID(),
              owner,
              catalog_entry_name: 'synthetic',
              pkce_challenge: 'P'.repeat(43),
              method: 'S256',
              client_nonce_hash: 'c'.repeat(64),
              replacement_handle: null,
            },
          },
        });
        const result = await pending.claimManagedForTenant(
          (await pending.getForUser(f.tenant, f.user, attempt))!,
          randomUUID()
        );
        if (result.outcome !== 'claimed') throw new Error('fixture exchange');
        const start = result.flow.exchangeStartedAt!.getTime();
        const commit = managedCommit(
          owner,
          {
            kind: 'exchange',
            claim_id: result.flow.exchangeClaimId!,
            claimed_at: start,
            deadline_at: start + 120000,
            refresh_generation: '0',
            refresh_success_generation: '0',
          },
          '0',
          'N'.repeat(43)
        );
        commit.metadata.transaction_id = transaction;
        await new UserMCPOAuthTokenRepository(db, master).saveToken(f.user, f.server, {
          accessToken: commit.tokens.access_token,
          refreshToken: commit.tokens.refresh_token,
          expiresAt: new Date(commit.tokens.expires_at),
          clientId: 'public-platform-id',
          managed: commit,
          grantBinding: {
            version: 5,
            generation,
            fingerprint: owner.config_fingerprint,
            metadataUri: 'https://provider.example.test/metadata',
            resourceUri: 'https://provider.example.test/mcp',
            issuer: 'https://provider.example.test/',
            authorizationEndpoint: 'https://provider.example.test/auth',
            tokenEndpoint: 'https://provider.example.test/token',
            redirectUri: 'https://broker.example.test/callback',
          },
        });
      });
      expect((await f.read()).managed_refresh_not_before).toBeNull();
      expect(
        await f.work(owned.db, (r) =>
          r.finishManagedRefreshRejection(f.user, f.server, f.claim, f.rejection)
        )
      ).toBe(false);
      expect((await f.read()).managed_refresh_not_before).toBeNull();
    });
    it('survives the original database owner connection shutting down and a fresh repository on the other pool', async () => {
      const f = await fixture();
      const results = await Promise.all(
        [owned.db, owned.peer].map((db) =>
          f.work(db, (r) => r.finishManagedRefreshRejection(f.user, f.server, f.claim, f.rejection))
        )
      );
      expect(results.sort()).toEqual([false, true]);
      const before = await f.read();
      await (owned.db as Database & { $client: postgres.Sql }).$client.end({ timeout: 2 });
      // Reopen an independent connection from this disposable fixture's synthetic
      // connection options only. No supplied URL, host credentials, or process cache.
      const options = owned.sql.options;
      const password: unknown = Reflect.get(options, 'pass');
      if (typeof password !== 'string') throw new Error('Fixture password unavailable');
      const url = new URL('postgresql://localhost');
      url.hostname = options.host[0];
      url.port = String(options.port[0]);
      url.username = options.user;
      url.password = password;
      url.pathname = options.database;
      const restarted = createDatabase({ dialect: 'postgresql', url: url.toString() });
      try {
        const observed = await f.work(restarted, (r) =>
          r.claimRefresh(f.user, f.server, {
            ...f.expected,
            refreshGeneration: f.claim.refreshGeneration,
          })
        );
        expect(observed.outcome).toBe('observed');
        expect((await f.read()).managed_refresh_not_before).toEqual(
          before.managed_refresh_not_before
        );
        expect((await f.read()).managed_metadata).toMatchObject({ next_sequence: '2' });
        await expect(
          f.work(restarted, (r) =>
            r.finishManagedRefreshRejection(f.user, f.server, f.claim, {
              ...f.rejection,
              operation_id: randomUUID(),
            })
          )
        ).resolves.toBe(false);
      } finally {
        await (restarted as unknown as { $client: postgres.Sql }).$client.end({ timeout: 2 });
      }
    });
  }
);
