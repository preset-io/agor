/** Production worker with disposable owned PG and the actual non-owner/column-limited definer. */
import {
  createTenantScopedDatabaseProxy,
  executeRaw,
  MCPManagedOAuthInvalidationRepository,
  MCPManagedOAuthOutboxRepository,
  runWithTenantDatabaseScope,
  sql,
  type TenantScopeAwareDatabase,
} from '@agor/core/db';
import type { ManagedMCPOAuthClient } from '@agor/core/tools/mcp/managed-oauth-client';
import { MCP_OAUTH_DISABLED_FLAGS } from '@agor/core/types';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { seedManagedRefreshGrant } from '../../../../packages/core/src/db/test-support/managed-oauth-fixture';
import {
  createOwnedPostgres,
  type OwnedPostgres,
} from '../../../../packages/core/src/db/test-support/owned-postgres';
import {
  createManagedOAuthMaintenance,
  type ManagedOAuthMaintenanceDependencies,
} from './mcp-oauth-managed-maintenance';
import type { ManagedMCPOAuthRuntime } from './mcp-oauth-managed-runtime';

const master = 'synthetic-maintenance-worker-master';
describe.skipIf(process.env.AGOR_DB_DIALECT !== 'postgresql')(
  'managed maintenance real non-owner composition',
  () => {
    let owned: OwnedPostgres;
    let db: TenantScopeAwareDatabase;
    beforeAll(async () => {
      owned = await createOwnedPostgres();
      db = createTenantScopedDatabaseProxy(owned.db, {
        requireScope: true,
        label: 'managed worker proof',
      });
    }, 120000);
    afterAll(async () => {
      await owned?.dispose();
    }, 30000);
    async function fixture() {
      const f = await seedManagedRefreshGrant(owned.db, master);
      const owner = f.commit.metadata.owner;
      const request = vi.fn(async (input: Parameters<ManagedMCPOAuthClient['request']>[0]) => {
        await input.assertCurrent();
        if (input.operation === 'close')
          return input.schema.parse({
            protocol_version: 1,
            closed: true,
            provider_revocation: 'pending',
          });
        throw new Error('unexpected synthetic operation');
      });
      const acknowledge = vi.fn(async () => {});
      const getCurrentIncarnation = vi.fn(async () => owner.recovery_incarnation);
      const capability = {
        protocol_version: 1,
        binding_version: 1,
        enforcement_version: 1,
        available: false,
        environment: owner.environment,
        residency_region: owner.residency_region,
        recovery_incarnation: owner.recovery_incarnation,
        profile_versions: [],
        flags: { ...MCP_OAUTH_DISABLED_FLAGS, revocation: true },
      };
      const dependencies: ManagedOAuthMaintenanceDependencies = {
        db,
        masterSecret: master,
        cellId: owner.cell_id,
        sender: { request } as Pick<ManagedMCPOAuthClient, 'request'>,
        clock: { latestUtcMs: () => Date.now() },
        getCurrentIncarnation,
        getCapabilities: async () => capability,
        assertCleanupAdmission: async () => {},
        acknowledge,
      };
      const pending = () =>
        runWithTenantDatabaseScope(db, f.tenant, (tx) =>
          new MCPManagedOAuthOutboxRepository(tx).listPending(f.tenant)
        );
      const retire = async (expire: boolean) =>
        runWithTenantDatabaseScope(db, f.tenant, async (tx) => {
          await executeRaw(tx, sql`DELETE FROM public.users WHERE user_id=${f.user}`);
          if (expire)
            await executeRaw(
              tx,
              sql`UPDATE public.mcp_managed_oauth_outbox SET expires_at=clock_timestamp()-interval '1 second' WHERE tenant_id=${f.tenant}`
            );
        });
      return {
        ...f,
        owner,
        request,
        acknowledge,
        getCurrentIncarnation,
        capability,
        dependencies,
        pending,
        retire,
      };
    }
    it('drains an exact old handle after subject deletion with vending disabled; no token or current subject needed', async () => {
      const f = await fixture();
      f.capability.available = false;
      await f.retire(true);
      const [job] = await f.pending();
      const worker = createManagedOAuthMaintenance(f.dependencies);
      await worker.runOnce();
      expect(await f.pending()).toEqual([]);
      const [sent] = f.request.mock.calls.find(([r]) => r.body.operation_id === job.operation_id)!;
      expect(sent.operation).toBe('close');
      expect(sent.body).toMatchObject({
        owner: f.owner,
        handle: f.commit.metadata.handle,
        expected_epoch: f.commit.metadata.handle_epoch,
        operation_id: job.operation_id,
      });
      expect(JSON.stringify(sent.body)).not.toContain(f.commit.tokens.refresh_token);
      expect(
        f.request.mock.calls.some(([r]) =>
          ['prepare', 'exchange', 'refresh', 'receipt'].includes(r.operation)
        )
      ).toBe(false);
      await worker.stop();
    });
    it('retains failed cleanup, retries the immutable old operation, and cannot mark a foreign-incarnation job done', async () => {
      const f = await fixture();
      await f.retire(true);
      const [job] = await f.pending();
      f.getCurrentIncarnation.mockResolvedValue('Z'.repeat(43));
      const worker = createManagedOAuthMaintenance(f.dependencies);
      await expect(worker.runOnce()).rejects.toThrow('recovery');
      expect(f.request).not.toHaveBeenCalled();
      expect((await f.pending())[0].operation_id).toBe(job.operation_id);
      f.getCurrentIncarnation.mockResolvedValue(f.owner.recovery_incarnation);
      f.request.mockRejectedValueOnce(new Error('synthetic lost response'));
      await worker.runOnce();
      expect((await f.pending())[0].operation_id).toBe(job.operation_id);
      await worker.runOnce();
      expect(await f.pending()).toEqual([]);
      const ids = f.request.mock.calls
        .filter(([r]) => r.id === f.commit.metadata.handle)
        .map(([r]) => r.body.operation_id);
      expect(new Set(ids)).toEqual(new Set([job.operation_id]));
    });
    it('does not discard unexpired revoke-only material merely because close was acknowledged', async () => {
      const f = await fixture();
      await f.retire(false);
      const [job] = await f.pending();
      const worker = createManagedOAuthMaintenance(f.dependencies);
      await worker.runOnce();
      expect((await f.pending())[0].outbox_id).toBe(job.outbox_id);
      await runWithTenantDatabaseScope(db, f.tenant, async (tx) => {
        expect(
          await new MCPManagedOAuthOutboxRepository(tx).openRevocationToken(
            f.tenant,
            job.outbox_id,
            job.operation_id,
            master
          )
        ).toBe(f.commit.tokens.refresh_token);
      });
      expect(
        f.request.mock.calls
          .filter(([r]) => r.id === f.commit.metadata.handle)
          .map(([r]) => r.operation)
      ).toEqual(['close']);
    });
    it('coalesces concurrent passes and ACKs committed metadata without decrypting a token', async () => {
      const f = await fixture();
      let release!: () => void;
      const blocked = new Promise<void>((r) => {
        release = r;
      });
      const getCapabilities = vi.fn(async () => {
        await blocked;
        return f.capability;
      });
      const worker = createManagedOAuthMaintenance({ ...f.dependencies, getCapabilities });
      const first = worker.runOnce();
      expect(worker.runOnce()).toBe(first);
      release();
      await first;
      expect(getCapabilities).toHaveBeenCalledTimes(1);
      expect(f.acknowledge).toHaveBeenCalledWith(f.commit.metadata);
      expect(JSON.stringify(f.acknowledge.mock.calls)).not.toContain(f.commit.tokens.access_token);
      await worker.stop();
    });
    it('atomically persists an active cell snapshot using the active sender, not the cleanup-only sender', async () => {
      const f = await fixture();
      f.capability.flags.managed_mcp_oauth_v1 = true;
      const invalidation = {
        cursor: '1',
        workspace_id: f.tenant,
        recovery_incarnation: f.owner.recovery_incarnation,
        subject: f.owner.cloud_user_subject,
        handle: f.commit.metadata.handle,
        reason: 'subject_removed',
        epoch: '2',
      };
      const activeRequest = vi.fn(
        async (input: Parameters<ManagedMCPOAuthClient['request']>[0]) => {
          await input.assertCurrent();
          return input.schema.parse({
            protocol_version: 1,
            recovery_incarnation: f.owner.recovery_incarnation,
            snapshot_required: false,
            snapshot_complete: true,
            next_cursor: '1',
            items: [invalidation],
          });
        }
      );
      const worker = createManagedOAuthMaintenance({
        ...f.dependencies,
        runtime: {
          dependencies: { client: { request: activeRequest } },
          reconcile: vi.fn(),
        } as unknown as ManagedMCPOAuthRuntime,
      });
      await worker.runOnce();
      const scope = {
        tenant_id: f.tenant,
        cell_id: f.owner.cell_id,
        environment: f.owner.environment,
        residency_region: f.owner.residency_region,
        recovery_incarnation: f.owner.recovery_incarnation,
      };
      await runWithTenantDatabaseScope(db, f.tenant, async (tx) => {
        expect(await new MCPManagedOAuthInvalidationRepository(tx).read(scope)).toMatchObject({
          status: 'ready',
          cursor: '1',
          items: [invalidation],
        });
      });
      expect(activeRequest).toHaveBeenCalled();
      expect(f.request.mock.calls.some(([r]) => r.operation === 'invalidations')).toBe(false);
    });
  }
);
