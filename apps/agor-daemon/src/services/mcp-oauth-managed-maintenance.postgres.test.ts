/** Production worker with disposable owned PG and the actual non-owner/column-limited definer. */
import { createHash, randomUUID } from 'node:crypto';
import {
  acquireTenantWriteGate,
  createTenantScopedDatabaseProxy,
  executeRaw,
  MCPManagedOAuthInvalidationRepository,
  MCPManagedOAuthOutboxRepository,
  runWithTenantDatabaseScope,
  sql,
  type TenantScopeAwareDatabase,
} from '@agor/core/db';
import type { ManagedMCPOAuthClient } from '@agor/core/tools/mcp/managed-oauth-client';
import {
  MCP_OAUTH_DISABLED_FLAGS,
  MCPManagedOAuthPendingMetadataSchema,
  type MCPOAuthAttemptID,
} from '@agor/core/types';
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
import { MCPOAuthPendingFlowAuthority } from './mcp-oauth-pending-flow-authority';

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
            cleanup_authorization_id: 'synthetic-cleanup-auth',
          });
        if (input.operation === 'cleanup')
          return input.schema.parse({
            protocol_version: 1,
            closed: true,
            provider_revocation: 'revoked',
          });
        if (input.operation === 'cancel_reservation')
          return input.schema.parse({
            protocol_version: 1,
            canceled: true,
            prepare_operation_id: input.body.prepare_operation_id,
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
        assertCleanupAdmission: async (value) => {
          if (value.workspace_id !== f.tenant) throw new Error('synthetic tenant admission denied');
        },
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
    it('drains daemon cleanup under the continuously held gate without enabling vending', async () => {
      const f = await fixture();
      const gate = await acquireTenantWriteGate(owned.db, f.tenant);
      const ready = () =>
        runWithTenantDatabaseScope(db, f.tenant, (tx) =>
          new MCPManagedOAuthOutboxRepository(tx).isTenantRetirementReady(f.tenant, gate.generation)
        );
      await runWithTenantDatabaseScope(db, f.tenant, (tx) =>
        new MCPManagedOAuthOutboxRepository(tx).retireTenantUnderWriteGate(
          f.tenant,
          gate.generation
        )
      );
      expect(await ready()).toBe(false);
      const worker = createManagedOAuthMaintenance(f.dependencies);
      await worker.runOnce();
      expect(await ready()).toBe(true);
      expect(f.capability.flags.managed_mcp_oauth_v1).toBe(false);
      expect(f.request.mock.calls.map(([r]) => r.operation)).toEqual(['close', 'cleanup']);
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
    it('does not discard unexpired revoke-only material when revocation is disabled', async () => {
      const f = await fixture();
      f.capability.flags.revocation = false;
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
    it('pins close authorization, uses only the old refresh/epoch, and terminates uncertain cleanup without retry', async () => {
      const f = await fixture();
      await f.retire(false);
      const [job] = await f.pending();
      const original = f.request.getMockImplementation()!;
      f.request.mockImplementation(async (input) => {
        if (input.operation === 'cleanup')
          return input.schema.parse({
            protocol_version: 1,
            closed: true,
            provider_revocation: 'uncertain',
          });
        return original(input);
      });
      const worker = createManagedOAuthMaintenance(f.dependencies);
      await worker.runOnce();
      expect(await f.pending()).toEqual([]);
      const [sent] = f.request.mock.calls.find(([r]) => r.operation === 'cleanup')!;
      expect(sent.body).toMatchObject({
        owner: f.owner,
        handle: f.commit.metadata.handle,
        expected_epoch: f.commit.metadata.handle_epoch,
        token: f.commit.tokens.refresh_token,
        token_type_hint: 'refresh_token',
        cleanup_authorization_id: 'synthetic-cleanup-auth',
      });
      expect(sent.body.operation_id).not.toBe(job.operation_id);
      const count = f.request.mock.calls.length;
      await worker.runOnce();
      expect(f.request).toHaveBeenCalledTimes(count);
    });
    it('retains in-progress cleanup with identical request bytes and rejects substituted close authorization', async () => {
      const f = await fixture();
      await f.retire(false);
      const original = f.request.getMockImplementation()!;
      f.request.mockImplementation(async (input) => {
        if (input.operation === 'cleanup')
          return input.schema.parse({
            protocol_version: 1,
            closed: true,
            provider_revocation: 'in_progress',
          });
        return original(input);
      });
      const [job] = await f.pending();
      const worker = createManagedOAuthMaintenance(f.dependencies);
      await worker.runOnce();
      const [bound] = await f.pending();
      await runWithTenantDatabaseScope(db, f.tenant, async (tx) => {
        const repo = new MCPManagedOAuthOutboxRepository(tx);
        expect(
          await repo.bindCleanupAuthorization(
            f.tenant,
            job.outbox_id,
            randomUUID(),
            bound.cleanup_authorization_id!,
            bound.cleanup_operation_id!
          )
        ).toBe(false);
        expect(
          await repo.bindCleanupAuthorization(
            f.tenant,
            job.outbox_id,
            job.operation_id,
            bound.cleanup_authorization_id!,
            randomUUID()
          )
        ).toBe(false);
      });
      const foreign = await fixture();
      await runWithTenantDatabaseScope(db, foreign.tenant, async (tx) => {
        expect(
          await new MCPManagedOAuthOutboxRepository(tx).bindCleanupAuthorization(
            foreign.tenant,
            job.outbox_id,
            job.operation_id,
            bound.cleanup_authorization_id!,
            bound.cleanup_operation_id!
          )
        ).toBe(false);
      });
      await worker.runOnce();
      const cleanup = f.request.mock.calls.filter(([r]) => r.operation === 'cleanup');
      expect(cleanup).toHaveLength(2);
      expect(JSON.stringify(cleanup[0][0].body)).toBe(JSON.stringify(cleanup[1][0].body));
      expect((await f.pending())[0].cleanup_authorization_id).toBe('synthetic-cleanup-auth');
      f.request.mockImplementation(async (input) => {
        if (input.operation === 'close')
          return input.schema.parse({
            protocol_version: 1,
            closed: true,
            provider_revocation: 'pending',
            cleanup_authorization_id: 'substituted',
          });
        return original(input);
      });
      await worker.runOnce();
      expect(f.request.mock.calls.filter(([r]) => r.operation === 'cleanup')).toHaveLength(2);
      expect((await f.pending())[0].cleanup_authorization_id).toBe('synthetic-cleanup-auth');
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
      expect(f.acknowledge).toHaveBeenCalledWith(
        f.commit.metadata,
        expect.objectContaining({ timeoutMs: expect.any(Number) })
      );
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
    it('cancels unknown reservations without replaying prepare, even with a live canonical cell credential', async () => {
      const f = await fixture();
      const flows = new MCPOAuthPendingFlowAuthority(db, master);
      const attemptId = randomUUID() as MCPOAuthAttemptID;
      const verifier = 'P'.repeat(43);
      const record = await flows.reserveManaged({
        tenantId: f.tenant,
        userId: f.user,
        mcpServerId: f.server,
        attemptId,
        build: (generation) => {
          const owner = { ...f.owner, attempt_id: attemptId, grant_generation: String(generation) };
          return {
            owner,
            pkce_verifier: verifier,
            prepare_request: {
              protocol_version: 1,
              operation_id: randomUUID(),
              owner,
              catalog_entry_name: 'synthetic',
              pkce_challenge: createHash('sha256').update(verifier).digest('base64url'),
              method: 'S256',
              client_nonce_hash: 'c'.repeat(64),
              replacement_handle: null,
            },
          };
        },
      });
      await flows.retireManagedAttempt(record);
      const [job] = await f.pending();
      expect(job.kind).toBe('recover_prepare_cancel');
      const original = f.request.getMockImplementation()!;
      f.request.mockImplementationOnce(async (input) =>
        input.schema.parse({
          protocol_version: 1,
          canceled: true,
          prepare_operation_id: 'substituted',
        })
      );
      const worker = createManagedOAuthMaintenance(f.dependencies);
      await worker.runOnce();
      expect((await f.pending())[0].outbox_id).toBe(job.outbox_id);
      f.request.mockImplementation(original);
      await worker.runOnce();
      expect(await f.pending()).toEqual([]);
      const [sent] = f.request.mock.calls.find(([r]) => r.operation === 'cancel_reservation')!;
      expect(sent.body).toEqual({
        protocol_version: 1,
        operation_id: job.operation_id,
        owner: job.metadata.owner,
        prepare_operation_id: MCPManagedOAuthPendingMetadataSchema.parse(job.metadata)
          .prepare_request.operation_id,
      });
      expect(f.request.mock.calls.some(([r]) => r.operation === 'prepare')).toBe(false);
    });
  }
);
