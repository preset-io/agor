import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { executeRaw, rawRows } from './database-wrapper';
import { lockMCPManagedSubject } from './repositories/authority-primitives';
import {
  beginManagedOAuthCellRetirement,
  readManagedOAuthCellRetirement,
} from './repositories/mcp-managed-oauth-cell-retirement';
import { listManagedOAuthMaintenanceTenants } from './repositories/mcp-managed-oauth-maintenance';
import { MCPManagedOAuthOutboxRepository } from './repositories/mcp-managed-oauth-outbox';
import { UserMCPOAuthTokenRepository } from './repositories/user-mcp-oauth-tokens';
import { deleteTenantData } from './tenant-deletion';
import { buildTenantDeletionManifest } from './tenant-deletion-manifest';
import { tenantPortabilityTableNames } from './tenant-portability-manifest';
import { runWithSystemDatabaseScope, runWithTenantDatabaseScope } from './tenant-scope';
import { managedCommit, seedManagedRefreshGrant } from './test-support/managed-oauth-fixture';
import { createOwnedPostgres, type OwnedPostgres } from './test-support/owned-postgres';

const master = 'synthetic-cell-retirement-master';
describe.skipIf(process.env.AGOR_DB_DIALECT !== 'postgresql')(
  'permanent cell stop (real non-owner)',
  () => {
    let owned: OwnedPostgres;
    beforeAll(async () => {
      owned = await createOwnedPostgres();
    }, 120000);
    afterAll(async () => {
      await owned?.dispose();
    }, 30000);
    it('serializes stop with admitted vending, rejects late results/new tenants and cannot be reopened or ported', async () => {
      const f = await seedManagedRefreshGrant(owned.db, master);
      const operation = randomUUID();
      const system = <T>(fn: Parameters<typeof runWithSystemDatabaseScope<T>>[2]) =>
        runWithSystemDatabaseScope(owned.db, 'owned cell retirement proof', fn, {
          capability: 'mcp_oauth_maintenance',
        });
      await expect(
        beginManagedOAuthCellRetirement(owned.db, f.owner.cell_id, operation)
      ).rejects.toThrow('maintenance');
      await expect(
        runWithTenantDatabaseScope(owned.db, f.tenant, (db) =>
          beginManagedOAuthCellRetirement(db, f.owner.cell_id, operation)
        )
      ).rejects.toThrow('maintenance');
      const claim = await runWithTenantDatabaseScope(owned.db, f.tenant, (db) =>
        new UserMCPOAuthTokenRepository(db, master).claimRefresh(f.user, f.server, f.expected)
      );
      if (claim.outcome !== 'claimed') throw new Error('fixture claim');
      let release!: () => void;
      let ready!: () => void;
      const locked = new Promise<void>((r) => {
        ready = r;
      });
      const barrier = new Promise<void>((r) => {
        release = r;
      });
      const writer = runWithTenantDatabaseScope(owned.peer, f.tenant, async (db) => {
        await lockMCPManagedSubject(
          db,
          f.tenant,
          f.user,
          f.owner.cloud_user_subject,
          f.owner.cell_id
        );
        ready();
        await barrier;
      });
      await locked;
      const stopping = system((db) =>
        beginManagedOAuthCellRetirement(db, f.owner.cell_id, operation)
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
      }
      const proof = await stopping;
      expect(
        await system((db) => beginManagedOAuthCellRetirement(db, f.owner.cell_id, operation))
      ).toEqual(proof);
      await expect(
        system((db) => beginManagedOAuthCellRetirement(db, f.owner.cell_id, randomUUID()))
      ).rejects.toThrow('operation');
      await expect(
        system((db) => readManagedOAuthCellRetirement(db, f.owner.cell_id, operation, randomUUID()))
      ).rejects.toThrow('generation');
      expect(
        await system((db) => readManagedOAuthCellRetirement(db, 'foreign-cell', operation))
      ).toBeNull();
      const started = claim.token.refresh_claimed_at!.getTime();
      const commit = managedCommit(
        f.owner,
        {
          kind: 'refresh',
          claim_id: claim.claimId,
          claimed_at: started,
          deadline_at: started + 120000,
          refresh_generation: String(claim.refreshGeneration),
          refresh_success_generation: '0',
        },
        '1'
      );
      commit.metadata.transaction_id = f.commit.metadata.transaction_id;
      await expect(
        runWithTenantDatabaseScope(owned.db, f.tenant, (db) =>
          new UserMCPOAuthTokenRepository(db, master).completeClaimedRefresh(
            f.user,
            f.server,
            claim,
            {
              accessToken: commit.tokens.access_token,
              refreshToken: commit.tokens.refresh_token,
              expiresAt: new Date(commit.tokens.expires_at),
              managed: commit,
            }
          )
        )
      ).rejects.toThrow('cell is retired');
      await runWithTenantDatabaseScope(owned.db, f.tenant, async (db) => {
        expect(
          (await new UserMCPOAuthTokenRepository(db, master).getToken(f.user, f.server))
            ?.oauth_access_token
        ).toBe(f.commit.tokens.access_token);
        expect(
          rawRows(
            await executeRaw(db, sql`SELECT * FROM public.mcp_managed_oauth_cell_retirements`)
          )
        ).toEqual([]);
        expect(
          rawRows(
            await executeRaw(
              db,
              sql`SELECT public.agor_mcp_managed_oauth_cell_vending_allowed('foreign-cell') AS allowed`
            )
          )[0].allowed
        ).toBe(true);
        const repo = new MCPManagedOAuthOutboxRepository(db);
        await repo.retireTenant(f.tenant);
        const [job] = await repo.listPending(f.tenant);
        // Synthetic authenticated terminal close result, no live provider access.
        await repo.complete(f.tenant, job.outbox_id, job.operation_id);
      });
      expect((await system((db) => listManagedOAuthMaintenanceTenants(db))).tenantIds).toEqual([]);
      await expect(
        seedManagedRefreshGrant(owned.db, master, `new-${randomUUID()}`)
      ).rejects.toThrow();
      expect((await system((db) => listManagedOAuthMaintenanceTenants(db))).tenantIds).toEqual([]);
      await system(async (db) => {
        expect(
          rawRows(
            await executeRaw(
              db,
              sql`UPDATE public.mcp_managed_oauth_cell_retirements SET operation_id='changed' RETURNING cell_id`
            )
          )
        ).toEqual([]);
        expect(
          rawRows(
            await executeRaw(
              db,
              sql`DELETE FROM public.mcp_managed_oauth_cell_retirements RETURNING cell_id`
            )
          )
        ).toEqual([]);
        expect(
          await readManagedOAuthCellRetirement(db, f.owner.cell_id, operation, proof.generation)
        ).toEqual(proof);
      });
      const [definer] = await owned.sql`SELECT r.rolsuper,r.rolbypassrls,
      has_column_privilege(p.proowner,'public.mcp_managed_oauth_cell_retirements','operation_id','SELECT') AS can_read_operation
      FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner WHERE p.oid='public.agor_mcp_managed_oauth_cell_vending_allowed(text)'::regprocedure`;
      expect(definer).toEqual({ rolsuper: false, rolbypassrls: false, can_read_operation: false });
      expect(buildTenantDeletionManifest().map((t) => t.name)).not.toContain(
        'mcp_managed_oauth_cell_retirements'
      );
      expect(tenantPortabilityTableNames()).not.toContain('mcp_managed_oauth_cell_retirements');
      expect(await deleteTenantData(owned.db, f.tenant)).toMatchObject({ tenantDataDeleted: true });
      expect(
        await system((db) =>
          readManagedOAuthCellRetirement(db, f.owner.cell_id, operation, proof.generation)
        )
      ).toEqual(proof);
    });
  }
);
