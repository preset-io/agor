/** Bounded composition of existing authorities. No provider I/O, refresh scheduler or token store. */
import {
  listManagedOAuthMaintenanceTenants,
  type MCPManagedOAuthCleanupEntry,
  MCPManagedOAuthInvalidationRepository,
  MCPManagedOAuthOutboxRepository,
  MCPOAuthPendingFlowRepository,
  runWithSystemDatabaseScope,
  runWithTenantDatabaseScope,
  type TenantScopeAwareDatabase,
  UserMCPOAuthTokenRepository,
} from '@agor/core/db';
import type { ManagedMCPOAuthClient } from '@agor/core/tools/mcp/managed-oauth-client';
import {
  type MCPManagedOAuthGrantMetadata,
  MCPManagedOAuthGrantMetadataSchema,
  type MCPManagedOAuthInvalidationScope,
  MCPManagedOAuthPendingMetadataSchema,
  McpOAuthCancelRequestSchema,
  McpOAuthCancelResponseSchema,
  McpOAuthCapabilitiesSchema,
  McpOAuthCloseRequestSchema,
  McpOAuthCloseResponseSchema,
  McpOAuthInvalidationResponseSchema,
  type McpOAuthOwner,
} from '@agor/core/types';
import type { ManagedAuthorityClock } from '../mcp-egress/managed-clock.js';
import { synchronizeManagedInvalidations } from '../mcp-egress/managed-invalidations.js';
import type { ManagedMCPOAuthRuntime } from './mcp-oauth-managed-runtime.js';

export interface ManagedOAuthMaintenanceDependencies {
  db: TenantScopeAwareDatabase;
  masterSecret: string;
  /** Omitted on a cleanup-only deployment. No vending path is then reachable. */
  runtime?: ManagedMCPOAuthRuntime;
  sender: Pick<ManagedMCPOAuthClient, 'request'>;
  clock: Pick<ManagedAuthorityClock, 'latestUtcMs'>;
  cellId: string;
  /** Fresh external recovery authority. Cleanup never calls the vending cohort loader. */
  getCurrentIncarnation: () => Promise<string>;
  getCapabilities: () => Promise<unknown>;
  /** Historical owner allowed ONLY for non-vending cleanup; not runtime.current(). */
  assertCleanupAdmission: (owner: McpOAuthOwner) => void | Promise<void>;
  /** Exact committed metadata only. Idempotent non-vending ACK, no token decrypt. */
  acknowledge: (metadata: MCPManagedOAuthGrantMetadata) => Promise<void>;
}

export interface ManagedOAuthMaintenanceResult {
  tenants: number;
  reconciled: number;
  acknowledged: number;
  closed: number;
  failures: number;
}

async function drainManagedOAuthCleanup(
  d: ManagedOAuthMaintenanceDependencies,
  tenant: string,
  job: MCPManagedOAuthCleanupEntry,
  current: () => Promise<void>,
  deadline: number,
  revocation: boolean
): Promise<void> {
  const owner = job.metadata.owner;
  const assertCurrent = async () => {
    await current();
    if (
      owner.workspace_id !== tenant ||
      owner.cell_id !== d.cellId ||
      owner.recovery_incarnation !== (await d.getCurrentIncarnation())
    )
      throw new Error('Managed cleanup owner unavailable');
    // Deliberately does not require the deleted user, current grant, or current placement epoch.
    await d.assertCleanupAdmission(owner);
    await current();
  };
  await assertCurrent();
  if (job.kind === 'recover_prepare_cancel') {
    // A prepare replay would vend authority on a cleanup-only deployment. Only
    // the canonical non-vending reservation-cancel route may settle this job.
    throw new Error('Managed reservation cancellation unavailable');
  }
  if (job.kind === 'cancel') {
    const metadata = MCPManagedOAuthPendingMetadataSchema.parse(job.metadata);
    const body = McpOAuthCancelRequestSchema.parse({
      protocol_version: 1,
      operation_id: job.operation_id,
      owner,
      transaction_id: job.transaction_id,
      expected_cancel_epoch: metadata.cancel_epoch,
    });
    await d.sender.request({
      operation: 'cancel',
      id: body.transaction_id,
      body,
      schema: McpOAuthCancelResponseSchema,
      assertCurrent,
      timeoutMs: Math.max(1, deadline - performance.now()),
    });
  } else {
    const metadata = MCPManagedOAuthGrantMetadataSchema.parse(job.metadata);
    const body = McpOAuthCloseRequestSchema.parse({
      protocol_version: 1,
      operation_id: job.operation_id,
      owner,
      handle: metadata.handle,
      expected_epoch: metadata.handle_epoch,
      reason: 'user_disconnect',
    });
    await d.sender.request({
      operation: 'close',
      id: metadata.handle,
      body,
      schema: McpOAuthCloseResponseSchema,
      assertCurrent,
      timeoutMs: Math.max(1, deadline - performance.now()),
    });
    if (job.expires_at.getTime() > d.clock.latestUtcMs()) {
      // Preserve revoke-only material until an authenticated cleanup authorization
      // is available. Close alone is not evidence of provider revocation.
      throw new Error(
        revocation
          ? 'Managed provider cleanup authorization unavailable'
          : 'Managed provider cleanup disabled'
      );
    }
  }
  await current();
  await runWithTenantDatabaseScope(d.db, tenant, (tx) =>
    new MCPManagedOAuthOutboxRepository(tx).complete(tenant, job.outbox_id, job.operation_id)
  );
}

/** Construction is inert. Bootstrap must explicitly start only an admitted deployment. */
export function createManagedOAuthMaintenance(d: ManagedOAuthMaintenanceDependencies) {
  const pages = new Map<string, { pending?: string; outbox?: string; ack?: string }>();
  let tenantCursor: string | undefined;
  let running: Promise<ManagedOAuthMaintenanceResult> | undefined;
  let controller: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let enabled = false;
  const pageSize = 25;

  async function run(signal: AbortSignal): Promise<ManagedOAuthMaintenanceResult> {
    const result = { tenants: 0, reconciled: 0, acknowledged: 0, closed: 0, failures: 0 };
    const deadline = performance.now() + 55000;
    const alive = () => {
      if (signal.aborted || performance.now() >= deadline)
        throw new Error('Managed maintenance stopped');
    };
    const capability = McpOAuthCapabilitiesSchema.parse(await d.getCapabilities());
    const incarnation = await d.getCurrentIncarnation();
    if (capability.recovery_incarnation !== incarnation)
      throw new Error('Managed recovery unavailable');
    const current = async () => {
      alive();
      d.clock.latestUtcMs();
      if ((await d.getCurrentIncarnation()) !== incarnation)
        throw new Error('Managed recovery changed');
      alive();
    };
    const routing = await runWithSystemDatabaseScope(
      d.db,
      'managed OAuth routing identifiers',
      (tx) => listManagedOAuthMaintenanceTenants(tx, tenantCursor, pageSize),
      { capability: 'mcp_oauth_maintenance' }
    );
    for (const tenant of routing.tenantIds) {
      if (signal.aborted || performance.now() >= deadline) break;
      await current();
      const cursor = pages.get(tenant) ?? {};
      const tenantWork = async <T>(fn: Parameters<typeof runWithTenantDatabaseScope<T>>[2]) =>
        runWithTenantDatabaseScope(d.db, tenant, fn);
      const attempt = async (fn: () => Promise<void>) => {
        try {
          await current();
          await fn();
        } catch {
          result.failures++;
        }
      };
      // Cleanup and ACK remain independent of vending availability and invalidation outages.
      await attempt(async () => {
        const jobs = await tenantWork((tx) =>
          new MCPManagedOAuthOutboxRepository(tx).listPending(tenant, pageSize, cursor.outbox)
        );
        for (const job of jobs) {
          await attempt(async () => {
            await drainManagedOAuthCleanup(
              d,
              tenant,
              job,
              current,
              deadline,
              capability.flags.revocation
            );
            result.closed++;
          });
          cursor.outbox = job.outbox_id;
        }
        if (jobs.length < pageSize) cursor.outbox = undefined;
      });
      await attempt(async () => {
        const receipts = await tenantWork((tx) =>
          new UserMCPOAuthTokenRepository(tx).listManagedReceiptsForAcknowledgement(
            tenant,
            cursor.ack,
            pageSize
          )
        );
        for (const metadata of receipts) {
          await attempt(async () => {
            if (metadata.owner.recovery_incarnation !== incarnation)
              throw new Error('Retired recovery');
            await d.assertCleanupAdmission(metadata.owner);
            await current();
            await d.acknowledge(metadata);
            result.acknowledged++;
          });
          cursor.ack = metadata.operation_id;
        }
        if (receipts.length < pageSize) cursor.ack = undefined;
      });
      if (d.runtime) {
        await attempt(async () => {
          const scope: MCPManagedOAuthInvalidationScope = {
            tenant_id: tenant,
            cell_id: d.cellId,
            environment: capability.environment,
            residency_region: capability.residency_region,
            recovery_incarnation: incarnation,
          };
          await synchronizeManagedInvalidations({
            recoveryIncarnation: incarnation,
            signal,
            request: (body) =>
              d.runtime!.dependencies.client.request({
                operation: 'invalidations',
                body,
                schema: McpOAuthInvalidationResponseSchema,
                assertCurrent: current,
                timeoutMs: Math.max(1, deadline - performance.now()),
              }),
            readCheckpoint: () =>
              tenantWork((tx) => new MCPManagedOAuthInvalidationRepository(tx).read(scope)),
            requireSnapshot: (expected) =>
              tenantWork(async (tx) => {
                const repo = new MCPManagedOAuthInvalidationRepository(tx);
                if ((await repo.read(scope)).cursor !== expected) return false;
                await repo.requireSnapshot(scope);
                return true;
              }),
            applyPage: (expected, page, options) =>
              tenantWork((tx) =>
                new MCPManagedOAuthInvalidationRepository(tx).applyPage(
                  scope,
                  expected,
                  page,
                  options
                )
              ),
          });
        });
        if (capability.flags.managed_mcp_oauth_v1 && capability.flags.exchange)
          await attempt(async () => {
            const pending = await tenantWork((tx) =>
              new MCPOAuthPendingFlowRepository(tx).listManagedForReconciliation(
                tenant,
                cursor.pending,
                pageSize
              )
            );
            for (const record of pending) {
              await attempt(async () => {
                await d.runtime!.reconcile(record);
                result.reconciled++;
              });
              cursor.pending = record.attemptId;
            }
            if (pending.length < pageSize) cursor.pending = undefined;
          });
      }
      // Bounded restartable fairness hints only; all authority and cleanup obligations are durable.
      if (pages.size >= 1000 && !pages.has(tenant)) pages.delete(pages.keys().next().value!);
      pages.set(tenant, cursor);
      tenantCursor = tenant;
      result.tenants++;
    }
    if (result.tenants === routing.tenantIds.length && !routing.nextCursor)
      tenantCursor = undefined;
    return result;
  }
  const runOnce = (): Promise<ManagedOAuthMaintenanceResult> => {
    if (running) return running;
    controller = new AbortController();
    running = run(controller.signal).finally(() => {
      running = undefined;
      controller = undefined;
    });
    return running;
  };
  const schedule = () => {
    if (!enabled || timer !== undefined) return;
    timer = setTimeout(
      () => {
        timer = undefined;
        void runOnce()
          .catch(() => undefined)
          .finally(schedule);
      },
      25000 + Math.floor(Math.random() * 10001)
    );
    timer.unref();
  };
  return {
    runOnce,
    start() {
      if (!enabled) {
        enabled = true;
        schedule();
      }
    },
    async stop() {
      enabled = false;
      if (timer) clearTimeout(timer);
      timer = undefined;
      controller?.abort();
      await running?.catch(() => undefined);
    },
  };
}
