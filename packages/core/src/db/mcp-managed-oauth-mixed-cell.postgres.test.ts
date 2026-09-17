import { createHash, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MCPOAuthAttemptID } from '../types';
import { executeRaw, rawRows } from './database-wrapper';
import { beginManagedOAuthCellRetirement } from './repositories/mcp-managed-oauth-cell-retirement';
import { listManagedOAuthMaintenanceTenants } from './repositories/mcp-managed-oauth-maintenance';
import { MCPManagedOAuthOutboxRepository } from './repositories/mcp-managed-oauth-outbox';
import { MCPOAuthPendingFlowRepository } from './repositories/mcp-oauth-pending-flows';
import { runWithSystemDatabaseScope, runWithTenantDatabaseScope } from './tenant-scope';
import { acquireTenantWriteGate } from './tenant-write-gate';
import { seedManagedRefreshGrant } from './test-support/managed-oauth-fixture';
import { createOwnedPostgres, type OwnedPostgres } from './test-support/owned-postgres';

const master = 'synthetic-mixed-cell-master';
describe.skipIf(process.env.AGOR_DB_DIALECT !== 'postgresql')(
  'cell-filtered retirement (real non-owner)',
  () => {
    let owned: OwnedPostgres;
    beforeAll(async () => {
      owned = await createOwnedPostgres();
    }, 120000);
    afterAll(async () => {
      await owned?.dispose();
    }, 30000);
    it('pages exact cell IDs and retires only matching pending/grants while preserving foreign orphan evidence', async () => {
      const tenant = `mixed-${randomUUID()}`;
      const a = await seedManagedRefreshGrant(owned.db, master, tenant, 'cell-a');
      const b = await seedManagedRefreshGrant(owned.db, master, tenant, 'cell-b');
      async function pending(f: typeof a) {
        const tenant = f.tenant;
        await runWithTenantDatabaseScope(owned.db, tenant, async (db) => {
          const repo = new MCPOAuthPendingFlowRepository(db);
          const subject = {
            tenantId: tenant,
            userId: f.user,
            mcpServerId: f.server,
            oauthMode: 'per_user' as const,
            subjectUserId: f.user,
          };
          const generation = await repo.allocateGrantGeneration(subject);
          const attempt = randomUUID() as MCPOAuthAttemptID;
          const owner = { ...f.owner, attempt_id: attempt, grant_generation: String(generation) };
          await repo.create({
            ...subject,
            attemptId: attempt,
            grantGeneration: generation,
            stateHash: createHash('sha256').update(attempt).digest('hex'),
            configFingerprintVersion: 5,
            configFingerprint: owner.config_fingerprint,
            envelopeVersion: 1,
            sealedMaterial: 'synthetic-pending',
            ttlMs: 600000,
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
        });
      }
      await pending(a);
      await pending(b);
      async function orphan(t: string, cell: string) {
        const f = await seedManagedRefreshGrant(owned.db, master, t, cell);
        await runWithTenantDatabaseScope(owned.db, t, async (db) => {
          await executeRaw(db, sql`DELETE FROM public.users WHERE user_id=${f.user}`);
          await executeRaw(db, sql`DELETE FROM public.mcp_servers WHERE mcp_server_id=${f.server}`);
        });
        return f;
      }
      await orphan(tenant, 'cell-a');
      await orphan(tenant, 'cell-b');
      const missing = await orphan(`orphan-${randomUUID()}`, 'cell-a');
      const foreign = await orphan(`foreign-${randomUUID()}`, 'cell-b');
      const foreignLive = await seedManagedRefreshGrant(owned.db, master, foreign.tenant, 'cell-b');
      await pending(foreignLive);
      const system = <T>(fn: Parameters<typeof runWithSystemDatabaseScope<T>>[2]) =>
        runWithSystemDatabaseScope(owned.db, 'mixed cell proof', fn, {
          capability: 'mcp_oauth_maintenance',
        });
      await system((db) => beginManagedOAuthCellRetirement(db, 'cell-a', randomUUID()));
      const ids: string[] = [];
      let cursor: string | undefined;
      for (let i = 0; i < 10; i++) {
        const page = await system((db) =>
          listManagedOAuthMaintenanceTenants(db, cursor, 1, 'cell-a')
        );
        expect(page.tenantIds.length).toBeLessThanOrEqual(1);
        ids.push(...page.tenantIds);
        if (page.nextCursor === null) break;
        cursor = page.nextCursor;
      }
      expect(ids).toEqual([tenant, missing.tenant].sort());
      expect(ids).not.toContain(foreign.tenant);
      expect(
        (
          await system((db) => listManagedOAuthMaintenanceTenants(db, undefined, 100, 'cell-b'))
        ).tenantIds.sort()
      ).toEqual([tenant, foreign.tenant].sort());
      expect(
        (await system((db) => listManagedOAuthMaintenanceTenants(db))).tenantIds.sort()
      ).toEqual([tenant, missing.tenant, foreign.tenant].sort());
      await expect(
        system((db) => listManagedOAuthMaintenanceTenants(db, undefined, 1, ''))
      ).rejects.toThrow();
      await system(async (db) => {
        for (const query of [
          sql`SELECT managed_metadata FROM public.user_mcp_oauth_tokens`,
          sql`SELECT managed_metadata,sealed_material FROM public.mcp_managed_oauth_outbox`,
        ])
          expect(rawRows(await executeRaw(db, query))).toEqual([]);
      });
      const gate = await acquireTenantWriteGate(owned.db, tenant);
      const within = <T>(fn: (r: MCPManagedOAuthOutboxRepository) => Promise<T>) =>
        runWithTenantDatabaseScope(owned.db, tenant, (db) =>
          fn(new MCPManagedOAuthOutboxRepository(db))
        );
      const snapshot = () =>
        runWithTenantDatabaseScope(owned.db, tenant, async (db) => ({
          pending: rawRows(
            await executeRaw(
              db,
              sql`SELECT to_jsonb(p) AS row FROM public.mcp_oauth_pending_flows p WHERE tenant_id=${tenant} AND managed_metadata->'owner'->>'cell_id'='cell-b' ORDER BY attempt_id`
            )
          ),
          grants: rawRows(
            await executeRaw(
              db,
              sql`SELECT to_jsonb(t) AS row FROM public.user_mcp_oauth_tokens t WHERE tenant_id=${tenant} AND managed_metadata->'owner'->>'cell_id'='cell-b' ORDER BY user_id`
            )
          ),
          outbox: rawRows(
            await executeRaw(
              db,
              sql`SELECT to_jsonb(o) AS row FROM public.mcp_managed_oauth_outbox o WHERE tenant_id=${tenant} AND managed_metadata->'owner'->>'cell_id'='cell-b' ORDER BY outbox_id`
            )
          ),
        }));
      const before = await snapshot();
      expect(
        await within((r) => r.getTenantRetirementStatus(tenant, gate.generation, 'cell-a'))
      ).toEqual({ ready: false, pending_attempts: 1, active_grants: 1, pending_cleanup: 1 });
      await expect(
        within((r) => r.retireTenantUnderWriteGate(tenant, randomUUID(), 'cell-a'))
      ).rejects.toThrow();
      await within((r) => r.retireTenantUnderWriteGate(tenant, gate.generation, 'cell-a'));
      expect(await snapshot()).toEqual(before);
      expect(
        await within((r) => r.getTenantRetirementStatus(tenant, gate.generation, 'cell-a'))
      ).toEqual({ ready: false, pending_attempts: 0, active_grants: 0, pending_cleanup: 3 });
      expect(
        await within((r) => r.getTenantRetirementStatus(tenant, gate.generation, 'cell-b'))
      ).toEqual({ ready: false, pending_attempts: 1, active_grants: 1, pending_cleanup: 1 });
      await within(async (r) => {
        for (const job of await r.listPending(tenant)) {
          if (job.metadata.owner.cell_id !== 'cell-a') continue;
          if (job.kind === 'recover_prepare_cancel' && 'prepare_request' in job.metadata)
            await r.completeReservationCancellation(
              tenant,
              job.outbox_id,
              job.operation_id,
              job.metadata.prepare_request.operation_id
            );
          else await r.complete(tenant, job.outbox_id, job.operation_id);
        }
      });
      expect(
        await within((r) => r.isTenantRetirementReady(tenant, gate.generation, 'cell-a'))
      ).toBe(true);
      expect(await within((r) => r.isTenantRetirementReady(tenant, gate.generation))).toBe(false);
      expect(await snapshot()).toEqual(before);
      expect(
        (await system((db) => listManagedOAuthMaintenanceTenants(db, undefined, 100, 'cell-a')))
          .tenantIds
      ).toEqual([missing.tenant]);
      await expect(
        runWithTenantDatabaseScope(owned.db, foreign.tenant, (db) =>
          new MCPManagedOAuthOutboxRepository(db).getTenantRetirementStatus(
            tenant,
            gate.generation,
            'cell-a'
          )
        )
      ).rejects.toThrow();
      // Explicit workspace retirement with no cell filter retains the old all-tenant meaning.
      await within((r) => r.retireTenantUnderWriteGate(tenant, gate.generation));
      expect(
        await within((r) => r.getTenantRetirementStatus(tenant, gate.generation, 'cell-b'))
      ).toEqual({ ready: false, pending_attempts: 0, active_grants: 0, pending_cleanup: 3 });
    });
  }
);
