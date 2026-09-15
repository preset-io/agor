import { createHash, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MCPOAuthAttemptID } from '../types';
import type {
  MCPManagedOAuthInvalidation,
  MCPManagedOAuthInvalidationScope,
} from '../types/mcp-managed-oauth';
import { executeRaw, rawRows } from './database-wrapper';
import { MCPManagedOAuthInvalidationRepository } from './repositories/mcp-managed-oauth-invalidations';
import { MCPOAuthPendingFlowRepository } from './repositories/mcp-oauth-pending-flows';
import { UserMCPOAuthTokenRepository } from './repositories/user-mcp-oauth-tokens';
import { runWithTenantDatabaseScope } from './tenant-scope';
import { managedCommit, seedManagedRefreshGrant } from './test-support/managed-oauth-fixture';
import { createOwnedPostgres, type OwnedPostgres } from './test-support/owned-postgres';

const master = 'synthetic-compaction-master';
type Fixture = Awaited<ReturnType<typeof seedManagedRefreshGrant>>;
function scope(f: Fixture): MCPManagedOAuthInvalidationScope {
  return {
    tenant_id: f.tenant,
    cell_id: f.owner.cell_id,
    environment: f.owner.environment,
    residency_region: f.owner.residency_region,
    recovery_incarnation: f.owner.recovery_incarnation,
  };
}
function handle() {
  return createHash('sha256').update(randomUUID()).digest('base64url');
}
function item(f: Fixture, h: string | null, cursor = '1'): MCPManagedOAuthInvalidation {
  return {
    workspace_id: f.tenant,
    recovery_incarnation: f.owner.recovery_incarnation,
    subject: null,
    handle: h,
    cursor,
    epoch: '1',
    reason: 'user_disconnect',
  };
}
function page(f: Fixture, items: MCPManagedOAuthInvalidation[], cursor = '1', complete = true) {
  return {
    protocol_version: 1 as const,
    recovery_incarnation: f.owner.recovery_incarnation,
    snapshot_required: false,
    snapshot_complete: complete,
    next_cursor: cursor,
    items,
  };
}

describe.skipIf(process.env.AGOR_DB_DIALECT !== 'postgresql')(
  'managed invalidation compaction (real non-owner)',
  () => {
    let owned: OwnedPostgres;
    beforeAll(async () => {
      owned = await createOwnedPostgres();
    }, 120000);
    afterAll(async () => {
      await owned?.dispose();
    }, 30000);
    const work = <T>(f: Fixture, fn: (r: MCPManagedOAuthInvalidationRepository) => Promise<T>) =>
      runWithTenantDatabaseScope(owned.db, f.tenant, (db) =>
        fn(new MCPManagedOAuthInvalidationRepository(db))
      );

    async function pending(f: Fixture) {
      return runWithTenantDatabaseScope(owned.db, f.tenant, async (db) => {
        const repo = new MCPOAuthPendingFlowRepository(db);
        const subject = {
          tenantId: f.tenant,
          userId: f.user,
          mcpServerId: f.server,
          oauthMode: 'per_user' as const,
          subjectUserId: f.user,
        };
        const generation = await repo.allocateGrantGeneration(subject);
        const attempt = randomUUID() as MCPOAuthAttemptID;
        const transaction = randomUUID();
        const owner = { ...f.owner, attempt_id: attempt, grant_generation: String(generation) };
        await repo.create({
          ...subject,
          attemptId: attempt,
          grantGeneration: generation,
          stateHash: createHash('sha256')
            .update(`agor-mcp-managed-v1\0${transaction}`)
            .digest('hex'),
          configFingerprintVersion: 5,
          configFingerprint: owner.config_fingerprint,
          envelopeVersion: 1,
          sealedMaterial: 'synthetic-envelope',
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
        return (await repo.getForUser(f.tenant, f.user, attempt))!;
      });
    }

    it('recovers an oversized old checkpoint and advances through more than 10000 closed handles', async () => {
      const f = await seedManagedRefreshGrant(owned.db, master);
      const live = item(f, f.commit.metadata.handle);
      const broad = item(f, null);
      await work(f, (r) => r.requireSnapshot(scope(f)));
      const old = [live, broad, ...Array.from({ length: 10001 }, () => item(f, handle()))];
      await runWithTenantDatabaseScope(owned.db, f.tenant, (db) =>
        executeRaw(
          db,
          sql`UPDATE public.mcp_managed_oauth_invalidations SET items=${JSON.stringify(old)}::jsonb WHERE tenant_id=${f.tenant}`
        )
      );
      expect((await work(f, (r) => r.read(scope(f)))).items).toEqual([live, broad]);
      let cursor: string | null = null;
      for (let n = 1; n <= 101; n++) {
        const next = String(n);
        expect(
          await work(f, (r) =>
            r.applyPage(
              scope(f),
              cursor,
              page(
                f,
                Array.from({ length: 100 }, () => item(f, handle(), next)),
                next
              ),
              { snapshot: n === 1 }
            )
          )
        ).toBe(true);
        cursor = next;
      }
      const read = await work(f, (r) => r.read(scope(f)));
      expect(read).toEqual({ status: 'ready', cursor: '101', items: [live, broad] });
      await runWithTenantDatabaseScope(owned.db, f.tenant, async (db) => {
        const row = rawRows(
          await executeRaw(
            db,
            sql`SELECT jsonb_array_length(items) AS count,page_digest,cursor
        FROM public.mcp_managed_oauth_invalidations WHERE tenant_id=${f.tenant}`
          )
        )[0];
        expect(row.count).toBe(2);
        expect(row.page_digest).toMatch(/^[a-f0-9]{64}$/);
        expect(row.cursor).toBe('101');
      });
    }, 30000);

    it('retains unknown handles across an actual pending-to-token transaction, including partial snapshots', async () => {
      const f = await seedManagedRefreshGrant(owned.db, master);
      const p = await pending(f);
      const claim = await runWithTenantDatabaseScope(owned.db, f.tenant, (db) =>
        new MCPOAuthPendingFlowRepository(db).claimManagedForTenant(p, randomUUID())
      );
      if (claim.outcome !== 'claimed') throw new Error('fixture claim');
      const start = claim.flow.exchangeStartedAt!.getTime();
      const commit = managedCommit(
        p.managedMetadata!.owner,
        {
          kind: 'exchange',
          claim_id: claim.flow.exchangeClaimId!,
          claimed_at: start,
          deadline_at: start + 120000,
          refresh_generation: '0',
          refresh_success_generation: '0',
        },
        '0',
        handle()
      );
      commit.metadata.transaction_id = p.managedTransactionId!;
      const tombstone = item(f, commit.metadata.handle);
      await work(f, (r) =>
        r.applyPage(scope(f), null, page(f, [tombstone], '1', false), { snapshot: true })
      );
      let saved!: () => void;
      const savedPromise = new Promise<void>((resolve) => {
        saved = resolve;
      });
      let release!: () => void;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      const writing = runWithTenantDatabaseScope(owned.peer, f.tenant, async (db) => {
        await new UserMCPOAuthTokenRepository(db, master).saveToken(f.user, f.server, {
          accessToken: commit.tokens.access_token,
          refreshToken: commit.tokens.refresh_token,
          expiresAt: new Date(commit.tokens.expires_at),
          clientId: 'public-platform-id',
          managed: commit,
          grantBinding: {
            version: 5,
            generation: p.grantGeneration,
            fingerprint: p.configFingerprint,
            metadataUri: 'https://provider.example.test/metadata',
            resourceUri: 'https://provider.example.test/mcp',
            issuer: 'https://provider.example.test/',
            authorizationEndpoint: 'https://provider.example.test/auth',
            tokenEndpoint: 'https://provider.example.test/token',
            redirectUri: 'https://broker.example.test/callback',
          },
        });
        saved();
        await released;
      });
      try {
        await Promise.race([
          savedPromise,
          writing.then(() => {
            throw new Error('writer ended early');
          }),
        ]);
        // The uncommitted writer has made pending terminal and inserted the new handle.
        // A concurrent SQL snapshot must still see its old pending side, not a gap.
        expect((await work(f, (r) => r.read(scope(f)))).items).toEqual([tombstone]);
      } finally {
        release();
        await writing;
      }
      await work(f, (r) => r.applyPage(scope(f), '1', page(f, [], '2'), { snapshot: true }));
      expect((await work(f, (r) => r.readForGrant(scope(f), commit.metadata))).items).toEqual([
        tombstone,
      ]);
    });

    it('never uses wall-clock expiry to erase a pending denial, and cannot resurrect a terminal attempt', async () => {
      const f = await seedManagedRefreshGrant(owned.db, master);
      const p = await pending(f);
      const unknown = item(f, handle());
      await work(f, (r) => r.applyPage(scope(f), null, page(f, [unknown]), { snapshot: true }));
      await runWithTenantDatabaseScope(owned.db, f.tenant, (db) =>
        executeRaw(
          db,
          sql`UPDATE public.mcp_oauth_pending_flows SET expires_at=clock_timestamp()-interval '1 second' WHERE attempt_id=${p.attemptId}`
        )
      );
      expect((await work(f, (r) => r.read(scope(f)))).items).toEqual([unknown]);
      expect(
        (
          await runWithTenantDatabaseScope(owned.db, f.tenant, (db) =>
            new MCPOAuthPendingFlowRepository(db).claimManagedForTenant(p, randomUUID())
          )
        ).outcome
      ).toBe('not_claimed');
      await runWithTenantDatabaseScope(owned.db, f.tenant, (db) =>
        executeRaw(
          db,
          sql`UPDATE public.mcp_oauth_pending_flows SET status='expired',is_current=false,sealed_material=NULL WHERE attempt_id=${p.attemptId}`
        )
      );
      expect((await work(f, (r) => r.read(scope(f)))).items).toEqual([]);
      expect(
        (
          await runWithTenantDatabaseScope(owned.db, f.tenant, (db) =>
            new MCPOAuthPendingFlowRepository(db).claimManagedForTenant(p, randomUUID())
          )
        ).outcome
      ).toBe('not_claimed');
    });

    it('keeps the cap fail-closed while an unknown-handle exchange is possible, then recovers after terminalization', async () => {
      const f = await seedManagedRefreshGrant(owned.db, master);
      const p = await pending(f);
      await work(f, (r) => r.requireSnapshot(scope(f)));
      const evidence = Array.from({ length: 10001 }, () => item(f, handle()));
      await runWithTenantDatabaseScope(owned.db, f.tenant, (db) =>
        executeRaw(
          db,
          sql`UPDATE public.mcp_managed_oauth_invalidations SET items=${JSON.stringify(evidence)}::jsonb WHERE tenant_id=${f.tenant}`
        )
      );
      await expect(work(f, (r) => r.read(scope(f)))).rejects.toThrow('capacity exceeded');
      await expect(
        work(f, (r) => r.applyPage(scope(f), null, page(f, []), { snapshot: true }))
      ).rejects.toThrow('capacity exceeded');
      await runWithTenantDatabaseScope(owned.db, f.tenant, async (db) => {
        const row = rawRows(
          await executeRaw(
            db,
            sql`SELECT cursor,jsonb_array_length(items) AS count FROM public.mcp_managed_oauth_invalidations WHERE tenant_id=${f.tenant}`
          )
        )[0];
        expect(row.cursor).toBeNull();
        expect(row.count).toBe(10001);
        await executeRaw(
          db,
          sql`UPDATE public.mcp_oauth_pending_flows SET status='failed',is_current=false,sealed_material=NULL WHERE attempt_id=${p.attemptId}`
        );
      });
      expect(
        await work(f, (r) => r.applyPage(scope(f), null, page(f, []), { snapshot: true }))
      ).toBe(true);
      expect((await work(f, (r) => r.read(scope(f)))).items).toEqual([]);
    });

    it('isolates cell/tenant/incarnation projections and retains expired live token and broad evidence', async () => {
      const f = await seedManagedRefreshGrant(owned.db, master, undefined, 'cell-a');
      const b = await seedManagedRefreshGrant(owned.db, master, f.tenant, 'cell-b');
      await pending(b);
      const bEvidence = item(b, handle());
      await work(b, (r) => r.applyPage(scope(b), null, page(b, [bEvidence]), { snapshot: true }));
      const live = item(f, f.commit.metadata.handle);
      const broad = item(f, null);
      await work(f, (r) =>
        r.applyPage(
          scope(f),
          null,
          page(f, [live, broad, item(f, b.commit.metadata.handle), item(f, handle())]),
          { snapshot: true }
        )
      );
      await runWithTenantDatabaseScope(owned.db, f.tenant, (db) =>
        executeRaw(
          db,
          sql`UPDATE public.user_mcp_oauth_tokens SET oauth_token_expires_at=clock_timestamp()-interval '1 hour' WHERE user_id=${f.user}`
        )
      );
      expect((await work(f, (r) => r.read(scope(f)))).items).toEqual([live, broad]);
      expect(
        (await work(f, (r) => r.read({ ...scope(f), recovery_incarnation: 'X'.repeat(43) }))).status
      ).toBe('snapshot_required');
      await expect(
        runWithTenantDatabaseScope(owned.peer, 'foreign', (db) =>
          new MCPManagedOAuthInvalidationRepository(db).read(scope(f))
        )
      ).rejects.toThrow();
      await runWithTenantDatabaseScope(owned.db, f.tenant, (db) =>
        executeRaw(db, sql`DELETE FROM public.user_mcp_oauth_tokens WHERE user_id=${f.user}`)
      );
      expect((await work(f, (r) => r.read(scope(f)))).items).toEqual([broad]);
      expect((await work(b, (r) => r.read(scope(b)))).items).toEqual([bEvidence]);
    });
  }
);
