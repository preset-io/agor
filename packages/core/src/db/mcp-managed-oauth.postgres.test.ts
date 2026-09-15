import { createHash, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MCPOAuthAttemptID } from '../types';
import { executeRaw, rawRows } from './database-wrapper';
import { lockMCPManagedSubject } from './repositories/authority-primitives';
import { MCPManagedOAuthInvalidationRepository } from './repositories/mcp-managed-oauth-invalidations';
import { MCPManagedOAuthOutboxRepository } from './repositories/mcp-managed-oauth-outbox';
import { MCPOAuthPendingFlowRepository } from './repositories/mcp-oauth-pending-flows';
import { MCPServerRepository } from './repositories/mcp-servers';
import { UserMCPOAuthTokenRepository } from './repositories/user-mcp-oauth-tokens';
import { UsersRepository } from './repositories/users';
import { deleteTenantData } from './tenant-deletion';
import { runWithSystemDatabaseScope, runWithTenantDatabaseScope } from './tenant-scope';
import { acquireTenantWriteGate, releaseTenantWriteGate } from './tenant-write-gate';
import { managedCommit, managedOwner } from './test-support/managed-oauth-fixture';
import { createOwnedPostgres, type OwnedPostgres } from './test-support/owned-postgres';

const MASTER = 'synthetic-owned-test-master-secret';
describe.skipIf(process.env.AGOR_DB_DIALECT !== 'postgresql')(
  'managed OAuth real non-owner authority',
  () => {
    let owned: OwnedPostgres;
    beforeAll(async () => {
      owned = await createOwnedPostgres();
    }, 120000);
    afterAll(async () => {
      await owned?.dispose();
    }, 30000);
    async function seed(bind = true) {
      const tenant = `managed-${randomUUID()}`;
      return runWithTenantDatabaseScope(owned.db, tenant, async (db) => {
        const user = await new UsersRepository(db).create({
          email: `${randomUUID()}@example.test`,
          role: 'member',
        });
        const server = await new MCPServerRepository(db).create({
          name: 'Synthetic',
          transport: 'http',
          url: 'https://provider.example.test/mcp',
          scope: 'global',
          enabled: true,
          source: 'user',
          owner_user_id: user.user_id,
          auth: { type: 'oauth', oauth_mode: 'per_user' },
        });
        await executeRaw(
          db,
          sql`INSERT INTO public.user_external_identities
        (tenant_id,identity_key,user_id,provider,issuer,subject,last_login_at,created_at,updated_at)
        VALUES (${tenant},${randomUUID()},${user.user_id},'cloud','https://cloud.example.test/','cloud-subject',clock_timestamp(),clock_timestamp(),clock_timestamp())`
        );
        const repo = new MCPOAuthPendingFlowRepository(db);
        const subject = {
          tenantId: tenant,
          mcpServerId: server.mcp_server_id,
          oauthMode: 'per_user' as const,
          subjectUserId: user.user_id,
        };
        const generation = await repo.allocateGrantGeneration(subject);
        const attempt = randomUUID() as MCPOAuthAttemptID;
        const owner = managedOwner({
          tenant,
          user: user.user_id,
          server: server.mcp_server_id,
          attempt,
          generation,
        });
        const prepare = {
          protocol_version: 1 as const,
          operation_id: randomUUID(),
          owner,
          catalog_entry_name: 'synthetic',
          pkce_challenge: 'P'.repeat(43),
          method: 'S256' as const,
          client_nonce_hash: 'c'.repeat(64),
          replacement_handle: null,
        };
        const transactionId = randomUUID();
        const stateHash = createHash('sha256')
          .update(bind ? `agor-mcp-managed-v1\0${transactionId}` : randomUUID())
          .digest('hex');
        await repo.create({
          ...subject,
          attemptId: attempt,
          stateHash,
          userId: user.user_id,
          grantGeneration: generation,
          configFingerprintVersion: 5,
          configFingerprint: owner.config_fingerprint,
          envelopeVersion: 1,
          sealedMaterial: 'synthetic-envelope',
          ttlMs: 600000,
          managedMetadata: { owner, prepare_request: prepare, cancel_epoch: '0' },
          ...(bind ? { managedTransactionId: transactionId } : {}),
        });
        return {
          tenant,
          user: user.user_id,
          server: server.mcp_server_id,
          owner,
          record: (await repo.getForUser(tenant, user.user_id, attempt))!,
        };
      });
    }
    async function exchange(seedValue: Awaited<ReturnType<typeof seed>>) {
      const f = seedValue;
      const claimed = await runWithTenantDatabaseScope(owned.db, f.tenant, (db) =>
        new MCPOAuthPendingFlowRepository(db).claimManagedForTenant(f.record, randomUUID())
      );
      if (claimed.outcome !== 'claimed') throw new Error('fixture claim failed');
      const flow = claimed.flow;
      const commit = managedCommit(f.owner, {
        kind: 'exchange',
        claim_id: flow.exchangeClaimId!,
        claimed_at: flow.exchangeStartedAt!.getTime(),
        deadline_at: flow.exchangeStartedAt!.getTime() + 120000,
        refresh_generation: '0',
        refresh_success_generation: '0',
      });
      commit.metadata.transaction_id = flow.managedTransactionId!;
      const save = async () =>
        runWithTenantDatabaseScope(owned.db, f.tenant, (db) =>
          new UserMCPOAuthTokenRepository(db, MASTER).saveToken(f.user, f.server, {
            accessToken: commit.tokens.access_token,
            refreshToken: commit.tokens.refresh_token,
            expiresAt: new Date(commit.tokens.expires_at),
            clientId: 'public-platform-id',
            managed: commit,
            grantBinding: {
              version: 5,
              generation: Number(f.owner.grant_generation),
              fingerprint: f.owner.config_fingerprint,
              metadataUri: 'https://provider.example.test/metadata',
              resourceUri: 'https://provider.example.test/mcp',
              issuer: 'https://provider.example.test/',
              authorizationEndpoint: 'https://provider.example.test/auth',
              tokenEndpoint: 'https://provider.example.test/token',
              redirectUri: 'https://broker.example.test/callback',
            },
          })
        );
      return { flow, commit, save };
    }
    it('excludes managed synthetic state from direct callback, manual, and foreign tenant claims', async () => {
      const f = await seed();
      await runWithTenantDatabaseScope(owned.db, f.tenant, async (db) =>
        expect(
          await new MCPOAuthPendingFlowRepository(db).claimForUser(
            f.tenant,
            f.user,
            f.record.stateHash,
            randomUUID()
          )
        ).toEqual({ outcome: 'not_claimed', flow: null })
      );
      await runWithSystemDatabaseScope(
        owned.peer,
        'managed callback denied',
        async (db) => {
          expect(
            await new MCPOAuthPendingFlowRepository(db).claimForCallback(
              f.record.stateHash,
              randomUUID()
            )
          ).toEqual({ outcome: 'not_claimed', flow: null });
          expect(
            rawRows(
              await executeRaw(
                db,
                sql`SELECT attempt_id FROM public.mcp_oauth_pending_flows WHERE state_hash=${f.record.stateHash}`
              )
            )
          ).toEqual([]);
        },
        { capability: 'mcp_oauth_callback' }
      );
      await expect(
        runWithTenantDatabaseScope(owned.peer, 'foreign', (db) =>
          new MCPOAuthPendingFlowRepository(db).claimManagedForTenant(f.record, randomUUID())
        )
      ).rejects.toThrow();
      const [a, b] = await Promise.all(
        [owned.db, owned.peer].map((pool) =>
          runWithTenantDatabaseScope(pool, f.tenant, (db) =>
            new MCPOAuthPendingFlowRepository(db).claimManagedForTenant(f.record, randomUUID())
          )
        )
      );
      expect([a, b].filter((x) => x.outcome === 'claimed')).toHaveLength(1);
    });
    it('persists receipt, permit, token and pending success atomically; closes only the exact old handle on demotion', async () => {
      const f = await seed();
      const e = await exchange(f);
      await e.save();
      await runWithTenantDatabaseScope(owned.db, f.tenant, async (db) => {
        const token = await new UserMCPOAuthTokenRepository(db, MASTER).getToken(f.user, f.server);
        expect(token?.managed_metadata).toEqual(e.commit.metadata);
        expect(token?.oauth_access_token).toBe(e.commit.tokens.access_token);
        expect(
          (
            await new MCPOAuthPendingFlowRepository(db).getForUser(
              f.tenant,
              f.user,
              f.record.attemptId
            )
          )?.status
        ).toBe('succeeded');
        await executeRaw(db, sql`UPDATE public.users SET role='viewer' WHERE user_id=${f.user}`);
        expect(
          await new UserMCPOAuthTokenRepository(db, MASTER).getToken(f.user, f.server)
        ).toBeNull();
        const jobs = await new MCPManagedOAuthOutboxRepository(db).listPending(f.tenant);
        expect(jobs).toHaveLength(1);
        expect(jobs[0].kind).toBe('close');
        expect(jobs[0].metadata).toEqual(e.commit.metadata);
        expect(JSON.stringify(jobs)).not.toContain(e.commit.tokens.refresh_token);
      });
      await expect(e.save()).rejects.toThrow();
    });
    it('enqueues cancellation before a handle or transaction exists and survives server deletion', async () => {
      const f = await seed(false);
      await runWithTenantDatabaseScope(owned.db, f.tenant, async (db) => {
        await executeRaw(db, sql`DELETE FROM public.mcp_servers WHERE mcp_server_id=${f.server}`);
        const repo = new MCPManagedOAuthOutboxRepository(db);
        const [job] = await repo.listPending(f.tenant);
        expect(job.kind).toBe('recover_prepare_cancel');
        expect(await repo.complete(f.tenant, job.outbox_id, job.operation_id)).toBe(false);
        expect(
          await repo.resolvePreparedCancellation(
            f.tenant,
            job.outbox_id,
            job.operation_id,
            'recovered-transaction',
            '1'
          )
        ).toBe(true);
        expect(await repo.complete(f.tenant, job.outbox_id, job.operation_id)).toBe(true);
        expect(await repo.complete(f.tenant, job.outbox_id, job.operation_id)).toBe(false);
      });
    });
    it('settles only the exact saved prepare after authenticated reservation cancellation', async () => {
      const f = await seed(false);
      await runWithTenantDatabaseScope(owned.db, f.tenant, async (db) => {
        await executeRaw(db, sql`DELETE FROM public.mcp_servers WHERE mcp_server_id=${f.server}`);
        const repo = new MCPManagedOAuthOutboxRepository(db);
        const [job] = await repo.listPending(f.tenant);
        const prepare = f.record.managedMetadata!.prepare_request.operation_id;
        expect(
          await repo.completeReservationCancellation(
            f.tenant,
            job.outbox_id,
            job.operation_id,
            randomUUID()
          )
        ).toBe(false);
        expect(
          await repo.completeReservationCancellation(f.tenant, job.outbox_id, randomUUID(), prepare)
        ).toBe(false);
        expect(
          await repo.completeReservationCancellation(
            f.tenant,
            job.outbox_id,
            job.operation_id,
            prepare
          )
        ).toBe(true);
        expect(
          await repo.completeReservationCancellation(
            f.tenant,
            job.outbox_id,
            job.operation_id,
            prepare
          )
        ).toBe(false);
        const [row] = rawRows(
          await executeRaw(
            db,
            sql`SELECT kind,transaction_id,completed_at FROM public.mcp_managed_oauth_outbox WHERE outbox_id=${job.outbox_id}`
          )
        );
        expect(row.kind).toBe('recover_prepare_cancel');
        expect(row.transaction_id).toBeNull();
        expect(row.completed_at).not.toBeNull();
      });
    });
    it('refuses an expired original exchange without a sweeper', async () => {
      const f = await seed();
      const e = await exchange(f);
      await runWithTenantDatabaseScope(owned.db, f.tenant, (db) =>
        executeRaw(
          db,
          sql`UPDATE public.mcp_oauth_pending_flows SET exchange_started_at=clock_timestamp()-interval '121 seconds' WHERE attempt_id=${f.record.attemptId}`
        )
      );
      await expect(e.save()).rejects.toThrow();
      await runWithTenantDatabaseScope(owned.db, f.tenant, async (db) =>
        expect(
          await new UserMCPOAuthTokenRepository(db, MASTER).getToken(f.user, f.server)
        ).toBeNull()
      );
    });
    it('advances certified rejection sequence once and never modifies the signed permit', async () => {
      const f = await seed();
      const e = await exchange(f);
      await e.save();
      await runWithTenantDatabaseScope(owned.db, f.tenant, async (db) => {
        const repo = new UserMCPOAuthTokenRepository(db, MASTER);
        const token = (await repo.getToken(f.user, f.server))!;
        const claim = await repo.claimRefresh(f.user, f.server, {
          grantGeneration: token.grant_generation,
          refreshGeneration: token.refresh_generation,
          grantBindingFingerprint: token.grant_binding_fingerprint,
        });
        if (claim.outcome !== 'claimed') throw new Error('fixture refresh failed');
        const started = claim.token.refresh_claimed_at!.getTime();
        const response = {
          protocol_version: 1 as const,
          operation_id: claim.claimId,
          owner: f.owner,
          claim: {
            kind: 'refresh' as const,
            claim_id: claim.claimId,
            claimed_at: started,
            deadline_at: started + 120000,
            refresh_generation: String(claim.refreshGeneration),
            refresh_success_generation: '0',
          },
          status: 'rejected_non_consuming' as const,
          failure_code: 'provider_rate_limited' as const,
          sequence: '1',
          next_sequence: '2',
          retry_after_ms: 1000,
        };
        expect(await repo.finishManagedRefreshRejection(f.user, f.server, claim, response)).toBe(
          true
        );
        expect(await repo.finishManagedRefreshRejection(f.user, f.server, claim, response)).toBe(
          false
        );
        const after = (await repo.getToken(f.user, f.server))!;
        expect(after.managed_metadata?.next_sequence).toBe('2');
        expect(after.managed_metadata?.use_authorization).toBe(e.commit.metadata.use_authorization);
      });
    });
    it('atomically journals per-tenant invalidations/cursor and denies partial snapshots or foreign scopes', async () => {
      const f = await seed();
      const e = await exchange(f);
      const scope = {
        tenant_id: f.tenant,
        cell_id: f.owner.cell_id,
        environment: f.owner.environment,
        residency_region: f.owner.residency_region,
        recovery_incarnation: f.owner.recovery_incarnation,
      };
      await runWithTenantDatabaseScope(owned.db, f.tenant, async (db) => {
        const repo = new MCPManagedOAuthInvalidationRepository(db);
        expect((await repo.readForGrant(scope, e.commit.metadata)).status).toBe(
          'snapshot_required'
        );
        const item = {
          cursor: '1',
          workspace_id: f.tenant,
          recovery_incarnation: scope.recovery_incarnation,
          subject: null,
          handle: e.commit.metadata.handle,
          reason: 'user_disconnect' as const,
          epoch: '1',
        };
        const page = {
          protocol_version: 1 as const,
          recovery_incarnation: scope.recovery_incarnation,
          snapshot_required: false,
          snapshot_complete: false,
          next_cursor: '1',
          items: [item],
        };
        expect(await repo.applyPage(scope, null, page, { snapshot: true })).toBe(true);
        expect(await repo.readForGrant(scope, e.commit.metadata)).toEqual({
          status: 'snapshot_staging',
          cursor: '1',
          items: [item],
        });
        expect(
          await repo.applyPage(
            scope,
            null,
            { ...page, snapshot_complete: true },
            { snapshot: true }
          )
        ).toBe(false);
        expect(
          await repo.applyPage(
            scope,
            '1',
            { ...page, next_cursor: '2', items: [], snapshot_complete: true },
            { snapshot: true }
          )
        ).toBe(true);
        expect((await repo.readForGrant(scope, e.commit.metadata)).items).toEqual([item]);
      });
      await expect(
        runWithTenantDatabaseScope(owned.peer, 'foreign', (db) =>
          new MCPManagedOAuthInvalidationRepository(db).read(scope)
        )
      ).rejects.toThrow();
    });

    it('checks the original deadline after a contended row lock, not transaction-start time', async () => {
      const f = await seed();
      const e = await exchange(f);
      const start = Date.now() - 119500;
      for (const c of [
        e.commit.metadata.claim,
        e.commit.metadata.receipt_claims.claim,
        e.commit.metadata.use_claims.claim,
      ]) {
        c.claimed_at = start;
        c.deadline_at = start + 120000;
      }
      await runWithTenantDatabaseScope(owned.db, f.tenant, (db) =>
        executeRaw(
          db,
          sql`UPDATE public.mcp_oauth_pending_flows SET exchange_started_at=to_timestamp(${start}/1000.0) WHERE attempt_id=${f.record.attemptId}`
        )
      );
      let unlock!: () => void;
      const gate = new Promise<void>((resolve) => {
        unlock = resolve;
      });
      let locked!: () => void;
      const ready = new Promise<void>((resolve) => {
        locked = resolve;
      });
      const holder = runWithTenantDatabaseScope(owned.peer, f.tenant, async (db) => {
        await executeRaw(
          db,
          sql`SELECT attempt_id FROM public.mcp_oauth_pending_flows WHERE attempt_id=${f.record.attemptId} FOR UPDATE`
        );
        locked();
        await gate;
      });
      await ready;
      const result = e.save().then(
        () => false,
        () => true
      );
      try {
        let blocked = false;
        for (let i = 0; i < 100; i++) {
          const rows =
            await owned.sql`SELECT 1 FROM pg_stat_activity WHERE usename=current_user AND cardinality(pg_blocking_pids(pid))>0`;
          if (rows.length) {
            blocked = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(blocked).toBe(true);
        await new Promise((resolve) => setTimeout(resolve, 600));
      } finally {
        unlock();
        await holder;
      }
      expect(await result).toBe(true);
    });
    it('closes the local identity remap write gap and queues retirement in the same transaction', async () => {
      const f = await seed();
      const e = await exchange(f);
      await e.save();
      await runWithTenantDatabaseScope(owned.peer, f.tenant, async (db) => {
        await executeRaw(
          db,
          sql`UPDATE public.user_external_identities SET subject='replacement-subject' WHERE user_id=${f.user}`
        );
        expect(
          await new UserMCPOAuthTokenRepository(db, MASTER).getToken(f.user, f.server)
        ).toBeNull();
        expect((await new MCPManagedOAuthOutboxRepository(db).listPending(f.tenant))[0].kind).toBe(
          'close'
        );
      });
      await expect(e.save()).rejects.toThrow();
    });
    it('keeps direct and managed catalog installs separate for the same owner', async () => {
      const f = await seed();
      await runWithTenantDatabaseScope(owned.db, f.tenant, async (db) => {
        const repo = new MCPServerRepository(db);
        const base = {
          name: 'Catalog synthetic',
          transport: 'http' as const,
          url: 'https://provider.example.test/mcp',
          scope: 'global' as const,
          enabled: true,
          source: 'catalog' as const,
          owner_user_id: f.user,
          catalog_entry_name: 'synthetic',
        };
        const direct = await repo.create({
          ...base,
          auth: { type: 'oauth', oauth_mode: 'per_user' },
        });
        const managed = await repo.create({
          ...base,
          auth: {
            type: 'oauth',
            oauth_mode: 'per_user',
            oauth_client_mode: 'cloud_managed_v1',
            oauth_managed_profile: {
              profile_id: 'profile',
              semantic_version: '1',
              environment: 'staging',
              region: 'us-west-2',
              registry_digest: 'a'.repeat(64),
            },
          },
        });
        expect(managed.mcp_server_id).not.toBe(direct.mcp_server_id);
        await expect(
          repo.update(direct.mcp_server_id, {
            auth: {
              type: 'oauth',
              oauth_mode: 'per_user',
              oauth_client_mode: 'cloud_managed_v1',
              oauth_managed_profile: {
                profile_id: 'profile',
                semantic_version: '1',
                environment: 'staging',
                region: 'us-west-2',
                registry_digest: 'a'.repeat(64),
              },
            },
          })
        ).rejects.toThrow();
      });
    });
    it('refresh completion atomically rotates the permit and rejects a duplicated response', async () => {
      const f = await seed();
      const e = await exchange(f);
      await e.save();
      await runWithTenantDatabaseScope(owned.db, f.tenant, async (db) => {
        const repo = new UserMCPOAuthTokenRepository(db, MASTER);
        const t = (await repo.getToken(f.user, f.server))!;
        const c = await repo.claimRefresh(f.user, f.server, {
          grantGeneration: t.grant_generation,
          refreshGeneration: t.refresh_generation,
          grantBindingFingerprint: t.grant_binding_fingerprint,
        });
        if (c.outcome !== 'claimed') throw new Error('fixture claim');
        const start = c.token.refresh_claimed_at!.getTime();
        const commit = managedCommit(
          f.owner,
          {
            kind: 'refresh',
            claim_id: c.claimId,
            claimed_at: start,
            deadline_at: start + 120000,
            refresh_generation: String(c.refreshGeneration),
            refresh_success_generation: '0',
          },
          '1'
        );
        commit.metadata.transaction_id = e.commit.metadata.transaction_id;
        const input = {
          accessToken: commit.tokens.access_token,
          refreshToken: commit.tokens.refresh_token,
          expiresAt: new Date(commit.tokens.expires_at),
          managed: commit,
        };
        expect(await repo.completeClaimedRefresh(f.user, f.server, c, input)).toBe(true);
        expect(await repo.completeClaimedRefresh(f.user, f.server, c, input)).toBe(false);
        expect((await repo.getToken(f.user, f.server))?.managed_metadata).toEqual(commit.metadata);
      });
    });
    it('the maintenance capability can cancel expired managed attempts without reading cleanup authorities', async () => {
      const f = await seed(false);
      await runWithTenantDatabaseScope(owned.db, f.tenant, (db) =>
        executeRaw(
          db,
          sql`UPDATE public.mcp_oauth_pending_flows SET expires_at=clock_timestamp()-interval '1 second' WHERE attempt_id=${f.record.attemptId}`
        )
      );
      await runWithSystemDatabaseScope(
        owned.peer,
        'fixture maintenance',
        async (db) => {
          expect(
            (await new MCPOAuthPendingFlowRepository(db).maintain()).expired
          ).toBeGreaterThanOrEqual(1);
          expect(
            rawRows(
              await executeRaw(db, sql`SELECT outbox_id FROM public.mcp_managed_oauth_outbox`)
            )
          ).toEqual([]);
        },
        { capability: 'mcp_oauth_maintenance' }
      );
      await runWithTenantDatabaseScope(owned.db, f.tenant, async (db) =>
        expect((await new MCPManagedOAuthOutboxRepository(db).listPending(f.tenant))[0].kind).toBe(
          'recover_prepare_cancel'
        )
      );
    });
    it('makes first write-gate acquisition wait for an already admitted managed transaction', async () => {
      const f = await seed(false);
      let release!: () => void;
      let admitted!: () => void;
      const started = new Promise<void>((r) => {
        admitted = r;
      });
      const barrier = new Promise<void>((r) => {
        release = r;
      });
      const writer = runWithTenantDatabaseScope(owned.db, f.tenant, async (db) => {
        await lockMCPManagedSubject(db, f.tenant, f.user, f.owner.cloud_user_subject);
        admitted();
        await barrier;
      });
      await started;
      const gate = acquireTenantWriteGate(owned.db, f.tenant);
      try {
        let blocked = false;
        for (let i = 0; i < 100; i++) {
          const rows =
            await owned.sql`SELECT 1 FROM pg_stat_activity WHERE usename=current_user AND cardinality(pg_blocking_pids(pid))>0`;
          if (rows.length) {
            blocked = true;
            break;
          }
          await new Promise((r) => setTimeout(r, 10));
        }
        expect(blocked).toBe(true);
      } finally {
        release();
      }
      await writer;
      const acquired = await gate;
      expect(acquired.generation).toBeTruthy();
      await expect(
        runWithTenantDatabaseScope(owned.db, f.tenant, (db) =>
          lockMCPManagedSubject(db, f.tenant, f.user, f.owner.cloud_user_subject)
        )
      ).rejects.toThrow();
    });
    it('fences production retirement/readiness to the continuously held tenant write gate', async () => {
      const f = await seed(false);
      const foreign = await seed(false);
      const gate = await acquireTenantWriteGate(owned.db, f.tenant);
      await expect(
        runWithTenantDatabaseScope(owned.db, f.tenant, (db) =>
          lockMCPManagedSubject(db, f.tenant, f.user, f.owner.cloud_user_subject)
        )
      ).rejects.toThrow('write');
      const within = <T>(fn: (repo: MCPManagedOAuthOutboxRepository) => Promise<T>) =>
        runWithTenantDatabaseScope(owned.db, f.tenant, (db) =>
          fn(new MCPManagedOAuthOutboxRepository(db))
        );
      await expect(
        within((r) => r.retireTenantUnderWriteGate(f.tenant, randomUUID()))
      ).rejects.toThrow();
      expect(await within((r) => r.isTenantRetirementReady(f.tenant, gate.generation))).toBe(false);
      await within((r) => r.retireTenantUnderWriteGate(f.tenant, gate.generation));
      expect(await within((r) => r.isTenantRetirementReady(f.tenant, gate.generation))).toBe(false);
      await within(async (r) => {
        const [job] = await r.listPending(f.tenant);
        const metadata = job.metadata;
        if (!('prepare_request' in metadata)) throw new Error('fixture not pending');
        expect(
          await r.completeReservationCancellation(
            f.tenant,
            job.outbox_id,
            job.operation_id,
            metadata.prepare_request.operation_id
          )
        ).toBe(true);
      });
      expect(await within((r) => r.isTenantRetirementReady(f.tenant, gate.generation))).toBe(true);
      await expect(
        runWithTenantDatabaseScope(owned.db, foreign.tenant, (db) =>
          new MCPManagedOAuthOutboxRepository(db).isTenantRetirementReady(f.tenant, gate.generation)
        )
      ).rejects.toThrow();
      await releaseTenantWriteGate(owned.db, f.tenant, { generation: gate.generation });
      await acquireTenantWriteGate(owned.db, f.tenant);
      await expect(
        within((r) => r.isTenantRetirementReady(f.tenant, gate.generation))
      ).rejects.toThrow();
    });
    it('gates tenant erasure until close confirmation and then erases cleanup rows without touching another tenant', async () => {
      const f = await seed(false);
      const other = await seed(false);
      await expect(deleteTenantData(owned.db, f.tenant)).rejects.toThrow('Managed OAuth authority');
      await runWithTenantDatabaseScope(owned.db, f.tenant, async (db) => {
        const repo = new MCPManagedOAuthOutboxRepository(db);
        await repo.retireTenant(f.tenant);
        const [job] = await repo.listPending(f.tenant);
        await repo.resolvePreparedCancellation(
          f.tenant,
          job.outbox_id,
          job.operation_id,
          'recovered',
          '1'
        );
        await repo.complete(f.tenant, job.outbox_id, job.operation_id);
      });
      expect(await deleteTenantData(owned.db, f.tenant)).toMatchObject({ tenantDataDeleted: true });
      await runWithTenantDatabaseScope(owned.db, other.tenant, async (db) =>
        expect(
          await new MCPOAuthPendingFlowRepository(db).getForUser(
            other.tenant,
            other.user,
            other.record.attemptId
          )
        ).not.toBeNull()
      );
    });
    it('refuses an expired original managed refresh without replacing the prior token', async () => {
      const f = await seed();
      const e = await exchange(f);
      await e.save();
      await runWithTenantDatabaseScope(owned.db, f.tenant, async (db) => {
        const repo = new UserMCPOAuthTokenRepository(db, MASTER);
        const t = (await repo.getToken(f.user, f.server))!;
        const c = await repo.claimRefresh(f.user, f.server, {
          grantGeneration: t.grant_generation,
          refreshGeneration: t.refresh_generation,
          grantBindingFingerprint: t.grant_binding_fingerprint,
        });
        if (c.outcome !== 'claimed') throw new Error('fixture claim');
        const start = Date.now() - 121000;
        await executeRaw(
          db,
          sql`UPDATE public.user_mcp_oauth_tokens SET refresh_claimed_at=to_timestamp(${start}/1000.0) WHERE user_id=${f.user} AND mcp_server_id=${f.server}`
        );
        const commit = managedCommit(
          f.owner,
          {
            kind: 'refresh',
            claim_id: c.claimId,
            claimed_at: start,
            deadline_at: start + 120000,
            refresh_generation: String(c.refreshGeneration),
            refresh_success_generation: '0',
          },
          '1'
        );
        commit.metadata.transaction_id = e.commit.metadata.transaction_id;
        expect(
          await repo.completeClaimedRefresh(f.user, f.server, c, {
            accessToken: commit.tokens.access_token,
            refreshToken: commit.tokens.refresh_token,
            expiresAt: new Date(commit.tokens.expires_at),
            managed: commit,
          })
        ).toBe(false);
        expect((await repo.getToken(f.user, f.server))?.oauth_access_token).toBe(
          e.commit.tokens.access_token
        );
      });
    });
    it('refuses refresh completion when its original deadline passes behind a real token row lock', async () => {
      const f = await seed();
      const e = await exchange(f);
      await e.save();
      const c = await runWithTenantDatabaseScope(owned.db, f.tenant, async (db) => {
        const repo = new UserMCPOAuthTokenRepository(db, MASTER);
        const t = (await repo.getToken(f.user, f.server))!;
        return repo.claimRefresh(f.user, f.server, {
          grantGeneration: t.grant_generation,
          refreshGeneration: t.refresh_generation,
          grantBindingFingerprint: t.grant_binding_fingerprint,
        });
      });
      if (c.outcome !== 'claimed') throw new Error('fixture claim');
      const start = Date.now() - 119500;
      await runWithTenantDatabaseScope(owned.db, f.tenant, (db) =>
        executeRaw(
          db,
          sql`UPDATE public.user_mcp_oauth_tokens SET refresh_claimed_at=to_timestamp(${start}/1000.0) WHERE user_id=${f.user} AND mcp_server_id=${f.server}`
        )
      );
      const commit = managedCommit(
        f.owner,
        {
          kind: 'refresh',
          claim_id: c.claimId,
          claimed_at: start,
          deadline_at: start + 120000,
          refresh_generation: String(c.refreshGeneration),
          refresh_success_generation: '0',
        },
        '1'
      );
      commit.metadata.transaction_id = e.commit.metadata.transaction_id;
      let release!: () => void;
      let ready!: () => void;
      const gate = new Promise<void>((r) => {
        release = r;
      });
      const locked = new Promise<void>((r) => {
        ready = r;
      });
      const holder = runWithTenantDatabaseScope(owned.peer, f.tenant, async (db) => {
        await executeRaw(
          db,
          sql`SELECT user_id FROM public.user_mcp_oauth_tokens WHERE user_id=${f.user} AND mcp_server_id=${f.server} FOR UPDATE`
        );
        ready();
        await gate;
      });
      await locked;
      const completing = runWithTenantDatabaseScope(owned.db, f.tenant, (db) =>
        new UserMCPOAuthTokenRepository(db, MASTER).completeClaimedRefresh(f.user, f.server, c, {
          accessToken: commit.tokens.access_token,
          refreshToken: commit.tokens.refresh_token,
          expiresAt: new Date(commit.tokens.expires_at),
          managed: commit,
        })
      );
      try {
        let blocked = false;
        for (let i = 0; i < 100; i++) {
          if (
            (
              await owned.sql`SELECT 1 FROM pg_stat_activity WHERE usename=current_user AND cardinality(pg_blocking_pids(pid))>0`
            ).length
          ) {
            blocked = true;
            break;
          }
          await new Promise((r) => setTimeout(r, 10));
        }
        expect(blocked).toBe(true);
        await new Promise((r) => setTimeout(r, 600));
      } finally {
        release();
        await holder;
      }
      expect(await completing).toBe(false);
      await runWithTenantDatabaseScope(owned.db, f.tenant, async (db) => {
        const token = await new UserMCPOAuthTokenRepository(db, MASTER).getToken(f.user, f.server);
        expect(token?.oauth_access_token).toBe(e.commit.tokens.access_token);
        expect(token?.managed_metadata).toEqual(e.commit.metadata);
      });
    });
    it('serializes a concurrent demotion behind the managed writer user-row lock, then retires its grant', async () => {
      const f = await seed();
      const e = await exchange(f);
      let release!: () => void;
      const gate = new Promise<void>((r) => {
        release = r;
      });
      let signal!: () => void;
      const saved = new Promise<void>((r) => {
        signal = r;
      });
      const writer = runWithTenantDatabaseScope(owned.db, f.tenant, async () => {
        await e.save();
        signal();
        await gate;
      });
      await saved;
      const demote = runWithTenantDatabaseScope(owned.peer, f.tenant, (db) =>
        executeRaw(db, sql`UPDATE public.users SET role='viewer' WHERE user_id=${f.user}`)
      );
      try {
        let blocked = false;
        for (let i = 0; i < 100; i++) {
          if (
            (
              await owned.sql`SELECT 1 FROM pg_stat_activity WHERE usename=current_user AND cardinality(pg_blocking_pids(pid))>0`
            ).length
          ) {
            blocked = true;
            break;
          }
          await new Promise((r) => setTimeout(r, 10));
        }
        expect(blocked).toBe(true);
      } finally {
        release();
        await writer;
        await demote;
      }
      await runWithTenantDatabaseScope(owned.db, f.tenant, async (db) => {
        expect(
          await new UserMCPOAuthTokenRepository(db, MASTER).getToken(f.user, f.server)
        ).toBeNull();
        expect((await new MCPManagedOAuthOutboxRepository(db).listPending(f.tenant))[0].kind).toBe(
          'close'
        );
      });
    });
  }
);
