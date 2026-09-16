import { createHash, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { MCPOAuthAttemptID } from '../types';
import type { McpOAuthOwner } from '../types/mcp-managed-oauth-contract';
import { executeRaw } from './database-wrapper';
import { MCPManagedOAuthOutboxRepository } from './repositories/mcp-managed-oauth-outbox';
import { MCPOAuthPendingFlowRepository } from './repositories/mcp-oauth-pending-flows';
import { UserMCPOAuthTokenRepository } from './repositories/user-mcp-oauth-tokens';
import { runWithTenantDatabaseScope } from './tenant-scope';
import { managedCommit, seedManagedRefreshGrant } from './test-support/managed-oauth-fixture';
import { createOwnedPostgres, type OwnedPostgres } from './test-support/owned-postgres';

const master = 'synthetic-retired-continuity-master';
const identity = { provider: 'cloud', issuer: 'https://cloud.example.test/' };
type Fixture = Awaited<ReturnType<typeof seedManagedRefreshGrant>>;
describe.skipIf(process.env.AGOR_DB_DIALECT !== 'postgresql')(
  'retired managed continuity (real non-owner)',
  () => {
    let owned: OwnedPostgres;
    beforeAll(async () => {
      owned = await createOwnedPostgres();
    }, 120000);
    afterAll(async () => {
      await owned?.dispose();
    }, 30000);
    const future = (f: Fixture): McpOAuthOwner => ({
      ...f.owner,
      attempt_id: randomUUID(),
      grant_generation: String(BigInt(f.owner.grant_generation) + 1n),
      config_fingerprint: 'f'.repeat(64),
    });
    const lookup = (
      f: Fixture,
      owner = future(f),
      fingerprint = (_generation: string) => f.owner.config_fingerprint,
      policy = identity
    ) =>
      runWithTenantDatabaseScope(owned.db, f.tenant, (db) =>
        new MCPManagedOAuthOutboxRepository(db).getRetiredGrantForReplacement(
          owner,
          policy,
          fingerprint
        )
      );
    async function retire(f: Fixture, complete = true) {
      return runWithTenantDatabaseScope(owned.db, f.tenant, async (db) => {
        await executeRaw(
          db,
          sql`DELETE FROM public.user_mcp_oauth_tokens WHERE user_id=${f.user} AND mcp_server_id=${f.server}`
        );
        const repo = new MCPManagedOAuthOutboxRepository(db);
        const job = (await repo.listPending(f.tenant)).find(
          (r) =>
            r.kind === 'close' && r.metadata.owner.grant_generation === f.owner.grant_generation
        )!;
        if (!job) throw new Error('fixture close missing');
        if (complete) {
          expect(
            await repo.bindCleanupAuthorization(
              f.tenant,
              job.outbox_id,
              job.operation_id,
              randomUUID(),
              randomUUID()
            )
          ).toBe(true);
          expect(await repo.complete(f.tenant, job.outbox_id, job.operation_id)).toBe(true);
        }
        return job;
      });
    }
    async function replacement(f: Fixture, minimumGeneration = 2): Promise<Fixture> {
      return runWithTenantDatabaseScope(owned.db, f.tenant, async (db) => {
        const pending = new MCPOAuthPendingFlowRepository(db);
        const subject = {
          tenantId: f.tenant,
          userId: f.user,
          mcpServerId: f.server,
          oauthMode: 'per_user' as const,
          subjectUserId: f.user,
        };
        let generation = await pending.allocateGrantGeneration(subject);
        while (generation < minimumGeneration)
          generation = await pending.allocateGrantGeneration(subject);
        const attempt = randomUUID() as MCPOAuthAttemptID;
        const transaction = randomUUID();
        const owner = { ...f.owner, grant_generation: String(generation), attempt_id: attempt };
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
          sealedMaterial: 'synthetic',
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
              replacement_handle: f.commit.metadata.handle,
            },
          },
        });
        const claimed = await pending.claimManagedForTenant(
          (await pending.getForUser(f.tenant, f.user, attempt))!,
          randomUUID()
        );
        if (claimed.outcome !== 'claimed') throw new Error('fixture claim');
        const start = claimed.flow.exchangeStartedAt!.getTime();
        const commit = managedCommit(
          owner,
          {
            kind: 'exchange',
            claim_id: claimed.flow.exchangeClaimId!,
            claimed_at: start,
            deadline_at: start + 120000,
            refresh_generation: '0',
            refresh_success_generation: '0',
          },
          '0',
          createHash('sha256').update(randomUUID()).digest('base64url')
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
        return { ...f, owner, commit, expected: { ...f.expected, grantGeneration: generation } };
      });
    }

    it('returns only original handle and full owner after durable cleanup, without opening secret material', async () => {
      const f = await seedManagedRefreshGrant(owned.db, master);
      expect(await lookup(f)).toBeNull();
      const job = await retire(f, false);
      expect(await lookup(f)).toBeNull();
      await runWithTenantDatabaseScope(owned.db, f.tenant, async (db) => {
        const repo = new MCPManagedOAuthOutboxRepository(db);
        await repo.bindCleanupAuthorization(
          f.tenant,
          job.outbox_id,
          job.operation_id,
          randomUUID(),
          randomUUID()
        );
      });
      expect(await lookup(f)).toBeNull();
      await runWithTenantDatabaseScope(owned.db, f.tenant, (db) =>
        new MCPManagedOAuthOutboxRepository(db).complete(f.tenant, job.outbox_id, job.operation_id)
      );
      const fingerprint = vi.fn(() => f.owner.config_fingerprint);
      const result = await lookup(f, future(f), fingerprint);
      expect(result).toEqual({ owner: f.owner, handle: f.commit.metadata.handle });
      expect(fingerprint).toHaveBeenCalledExactlyOnceWith(f.owner.grant_generation);
      expect(Object.keys(result!)).toEqual(['owner', 'handle']);
      expect(JSON.stringify(result)).not.toContain(f.commit.tokens.access_token);
      expect(JSON.stringify(result)).not.toContain(f.commit.tokens.refresh_token);
      expect(JSON.stringify(result)).not.toContain('synthetic.use.signature');
      // Cleanup TTL expiration does not erase nonsecret lineage or authorize provider use.
      await runWithTenantDatabaseScope(owned.db, f.tenant, (db) =>
        executeRaw(
          db,
          sql`UPDATE public.mcp_managed_oauth_outbox SET expires_at=clock_timestamp()-interval '1 day' WHERE outbox_id=${job.outbox_id}`
        )
      );
      expect(await lookup(f)).toEqual(result);
    });

    it('selects the latest numeric generation, never an older completed fallback or an active replacement', async () => {
      const first = await seedManagedRefreshGrant(owned.db, master);
      await retire(first);
      const ninth = await replacement(first, 9);
      await retire(ninth);
      const tenth = await replacement(ninth, 10);
      expect(await lookup(tenth)).toBeNull();
      const job = await retire(tenth, false);
      expect(await lookup(tenth)).toBeNull();
      await runWithTenantDatabaseScope(owned.db, tenth.tenant, async (db) => {
        const repo = new MCPManagedOAuthOutboxRepository(db);
        await repo.bindCleanupAuthorization(
          tenth.tenant,
          job.outbox_id,
          job.operation_id,
          randomUUID(),
          randomUUID()
        );
        await repo.complete(tenth.tenant, job.outbox_id, job.operation_id);
      });
      expect(await lookup(tenth)).toEqual({
        owner: tenth.owner,
        handle: tenth.commit.metadata.handle,
      });
      await runWithTenantDatabaseScope(owned.db, tenth.tenant, (db) =>
        executeRaw(
          db,
          sql`UPDATE public.mcp_managed_oauth_outbox SET managed_metadata=jsonb_set(managed_metadata,'{owner,profile_id}','"different-profile"'::jsonb) WHERE outbox_id=${job.outbox_id}`
        )
      );
      expect(await lookup(tenth)).toBeNull();
    });

    it('requires every immutable owner fence and an old-generation HMAC for current configuration', async () => {
      const f = await seedManagedRefreshGrant(owned.db, master);
      await retire(f);
      const changes: Partial<McpOAuthOwner>[] = [
        { environment: 'production' },
        { recovery_incarnation: 'X'.repeat(43) },
        { profile_id: 'other' },
        { profile_version: '2' },
        { catalog_digest: 'c'.repeat(64) },
        { cell_id: 'other' },
        { data_plane_id: 'other' },
        { membership_id: 'other' },
        { placement_epoch: '2' },
        { identity_epoch: '2' },
        { user_identity_epoch: '2' },
        { cell_authority_epoch: '2' },
        { data_plane_authority_epoch: '2' },
        { server_id: randomUUID() },
        { grant_generation: f.owner.grant_generation },
        { grant_generation: '0' },
      ];
      for (const change of changes) expect(await lookup(f, { ...future(f), ...change })).toBeNull();
      expect(await lookup(f, future(f), () => 'd'.repeat(64))).toBeNull();
      expect(
        await lookup(f, future(f), undefined, {
          ...identity,
          issuer: 'https://other.example.test/',
        })
      ).toBeNull();
      expect(await lookup(f, future(f), undefined, { ...identity, provider: 'other' })).toBeNull();
      await expect(
        runWithTenantDatabaseScope(owned.peer, 'foreign', (db) =>
          new MCPManagedOAuthOutboxRepository(db).getRetiredGrantForReplacement(
            future(f),
            identity,
            () => f.owner.config_fingerprint
          )
        )
      ).rejects.toThrow();
      await expect(
        lookup(f, { ...future(f), cloud_user_subject: 'foreign-subject' })
      ).rejects.toThrow();
      await expect(lookup(f, { ...future(f), cell_local_user_id: randomUUID() })).rejects.toThrow();
    });

    it('denies ambiguous normalized mappings and non-current local profile configuration', async () => {
      const f = await seedManagedRefreshGrant(owned.db, master);
      await retire(f);
      const key = randomUUID();
      await runWithTenantDatabaseScope(owned.db, f.tenant, (db) =>
        executeRaw(
          db,
          sql`INSERT INTO public.user_external_identities (tenant_id,identity_key,user_id,provider,issuer,subject,last_login_at,created_at,updated_at)
          VALUES (${f.tenant},${key},${f.user},${identity.provider},${identity.issuer},'ambiguous-subject',clock_timestamp(),clock_timestamp(),clock_timestamp())`
        )
      );
      expect(await lookup(f)).toBeNull();
      await runWithTenantDatabaseScope(owned.db, f.tenant, (db) =>
        executeRaw(db, sql`DELETE FROM public.user_external_identities WHERE identity_key=${key}`)
      );
      expect(await lookup(f)).not.toBeNull();
      await runWithTenantDatabaseScope(owned.db, f.tenant, (db) =>
        executeRaw(
          db,
          sql`UPDATE public.mcp_servers SET data=jsonb_set(data,'{auth,oauth_managed_profile,semantic_version}','"2"'::jsonb) WHERE mcp_server_id=${f.server}`
        )
      );
      expect(await lookup(f)).toBeNull();
    });

    it('denies normalized identity replacement, demotion, deleted server and missing close delivery proof', async () => {
      const f = await seedManagedRefreshGrant(owned.db, master);
      const job = await retire(f);
      await runWithTenantDatabaseScope(owned.db, f.tenant, (db) =>
        executeRaw(
          db,
          sql`UPDATE public.user_external_identities SET subject='replacement-subject' WHERE user_id=${f.user}`
        )
      );
      await expect(lookup(f)).rejects.toThrow();
      await runWithTenantDatabaseScope(owned.db, f.tenant, (db) =>
        executeRaw(
          db,
          sql`UPDATE public.user_external_identities SET subject=${f.owner.cloud_user_subject} WHERE user_id=${f.user}`
        )
      );
      await runWithTenantDatabaseScope(owned.db, f.tenant, (db) =>
        executeRaw(db, sql`UPDATE public.users SET role='guest' WHERE user_id=${f.user}`)
      );
      await expect(lookup(f)).rejects.toThrow();
      await runWithTenantDatabaseScope(owned.db, f.tenant, (db) =>
        executeRaw(db, sql`UPDATE public.users SET role='member' WHERE user_id=${f.user}`)
      );
      await runWithTenantDatabaseScope(owned.db, f.tenant, (db) =>
        executeRaw(
          db,
          sql`UPDATE public.mcp_managed_oauth_outbox SET cleanup_authorization_id=NULL,cleanup_operation_id=NULL WHERE outbox_id=${job.outbox_id}`
        )
      );
      expect(await lookup(f)).toBeNull();
      const deleted = await seedManagedRefreshGrant(owned.db, master);
      await retire(deleted);
      expect(await lookup(deleted)).not.toBeNull();
      await runWithTenantDatabaseScope(owned.db, deleted.tenant, (db) =>
        executeRaw(db, sql`DELETE FROM public.mcp_servers WHERE mcp_server_id=${deleted.server}`)
      );
      expect(await lookup(deleted)).toBeNull();
    });
  }
);
