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
  MCP_OAUTH_LIMITS,
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
  getCurrentIncarnation: (budget?: ManagedOAuthMaintenanceBudget) => Promise<string>;
  getCapabilities: (budget?: ManagedOAuthMaintenanceBudget) => Promise<unknown>;
  /** Historical owner allowed ONLY for non-vending cleanup; not runtime.current(). */
  assertCleanupAdmission: (owner: McpOAuthOwner) => void | Promise<void>;
  /** Exact committed metadata only. Idempotent non-vending ACK, no token decrypt. */
  acknowledge: (
    metadata: MCPManagedOAuthGrantMetadata,
    budget?: ManagedOAuthMaintenanceBudget
  ) => Promise<void>;
  /** Aggregate-only observers. Errors/rejections cannot affect durable work. */
  onResult?: (result: Readonly<ManagedOAuthMaintenanceResult>) => void;
  onUnavailable?: () => void;
}

export interface ManagedOAuthMaintenanceBudget {
  timeoutMs: number;
  signal: AbortSignal;
}

export interface ManagedOAuthMaintenanceResult {
  tenants: number;
  reconciled: number;
  acknowledged: number;
  closed: number;
  failures: number;
  capacityLimited: boolean;
}

async function drainManagedOAuthCleanup(
  d: ManagedOAuthMaintenanceDependencies,
  tenant: string,
  job: MCPManagedOAuthCleanupEntry,
  current: () => Promise<void>,
  budget: () => ManagedOAuthMaintenanceBudget,
  revocation: boolean
): Promise<void> {
  const owner = job.metadata.owner;
  const assertCurrent = async () => {
    await current();
    if (
      owner.workspace_id !== tenant ||
      owner.cell_id !== d.cellId ||
      owner.recovery_incarnation !== (await d.getCurrentIncarnation(budget()))
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
      timeoutMs: budget().timeoutMs,
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
      timeoutMs: budget().timeoutMs,
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

/**
 * Construction is inert. Bootstrap explicitly starts only an admitted deployment.
 * The 30–35s cadence is a pass target, not a per-tenant delivery SLA: 25-tenant
 * pages, bounded job pages and a 25s admission budget can require later passes.
 * capacityLimited reports saturation; durable checkpoints retain every denial.
 * Dependencies must honor the supplied remaining I/O budget. If one overruns,
 * single-flight wins over cadence; never abandon an owner or accumulate retries.
 */
export function createManagedOAuthMaintenance(d: ManagedOAuthMaintenanceDependencies) {
  const pages = new Map<string, { pending?: string; outbox?: string; ack?: string }>();
  let tenantCursor: string | undefined;
  let running: Promise<ManagedOAuthMaintenanceResult> | undefined;
  let controller: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let nextStart = 0;
  let enabled = false;
  const pageSize = 25;

  async function run(signal: AbortSignal): Promise<ManagedOAuthMaintenanceResult> {
    const result = {
      tenants: 0,
      reconciled: 0,
      acknowledged: 0,
      closed: 0,
      failures: 0,
      capacityLimited: false,
    };
    const deadline = performance.now() + 25000;
    const alive = () => {
      if (signal.aborted || performance.now() >= deadline)
        throw new Error('Managed maintenance stopped');
    };
    const budget = (): ManagedOAuthMaintenanceBudget => {
      alive();
      return {
        signal,
        timeoutMs: Math.max(
          1,
          Math.min(MCP_OAUTH_LIMITS.recovery_timeout_ms, Math.floor(deadline - performance.now()))
        ),
      };
    };
    const capability = McpOAuthCapabilitiesSchema.parse(await d.getCapabilities(budget()));
    const incarnation = await d.getCurrentIncarnation(budget());
    if (capability.recovery_incarnation !== incarnation)
      throw new Error('Managed recovery unavailable');
    const current = async () => {
      alive();
      d.clock.latestUtcMs();
      if ((await d.getCurrentIncarnation(budget())) !== incarnation)
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
      if (signal.aborted || performance.now() >= deadline) {
        result.capacityLimited = true;
        break;
      }
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
      // Apply known invalidations before potentially slow provider cleanup.
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
                timeoutMs: budget().timeoutMs,
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
      }
      // Cleanup and ACK remain independent of vending availability and invalidation outages.
      await attempt(async () => {
        const jobs = await tenantWork((tx) =>
          new MCPManagedOAuthOutboxRepository(tx).listPending(tenant, pageSize, cursor.outbox)
        );
        let scanned = 0;
        for (const job of jobs) {
          if (signal.aborted || performance.now() >= deadline) {
            result.capacityLimited = true;
            break;
          }
          await attempt(async () => {
            await drainManagedOAuthCleanup(
              d,
              tenant,
              job,
              current,
              budget,
              capability.flags.revocation
            );
            result.closed++;
          });
          cursor.outbox = job.outbox_id;
          scanned++;
        }
        if (jobs.length < pageSize && scanned === jobs.length) cursor.outbox = undefined;
        if (jobs.length === pageSize) result.capacityLimited = true;
      });
      await attempt(async () => {
        const receipts = await tenantWork((tx) =>
          new UserMCPOAuthTokenRepository(tx).listManagedReceiptsForAcknowledgement(
            tenant,
            cursor.ack,
            pageSize
          )
        );
        let scanned = 0;
        for (const metadata of receipts) {
          if (signal.aborted || performance.now() >= deadline) {
            result.capacityLimited = true;
            break;
          }
          await attempt(async () => {
            if (metadata.owner.recovery_incarnation !== incarnation)
              throw new Error('Retired recovery');
            await d.assertCleanupAdmission(metadata.owner);
            await current();
            await d.acknowledge(metadata, budget());
            result.acknowledged++;
          });
          cursor.ack = metadata.operation_id;
          scanned++;
        }
        if (receipts.length < pageSize && scanned === receipts.length) cursor.ack = undefined;
        if (receipts.length === pageSize) result.capacityLimited = true;
      });
      if (d.runtime) {
        if (capability.flags.managed_mcp_oauth_v1 && capability.flags.exchange)
          await attempt(async () => {
            const pending = await tenantWork((tx) =>
              new MCPOAuthPendingFlowRepository(tx).listManagedForReconciliation(
                tenant,
                cursor.pending,
                pageSize
              )
            );
            let scanned = 0;
            for (const record of pending) {
              if (signal.aborted || performance.now() >= deadline) {
                result.capacityLimited = true;
                break;
              }
              await attempt(async () => {
                await d.runtime!.reconcile(record, {
                  assertCurrent: current,
                  timeoutMs: budget().timeoutMs,
                });
                result.reconciled++;
              });
              cursor.pending = record.attemptId;
              scanned++;
            }
            if (pending.length < pageSize && scanned === pending.length) cursor.pending = undefined;
            if (pending.length === pageSize) result.capacityLimited = true;
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
    if (routing.nextCursor !== null) result.capacityLimited = true;
    if (signal.aborted || performance.now() >= deadline) result.capacityLimited = true;
    return result;
  }
  const runOnce = (): Promise<ManagedOAuthMaintenanceResult> => {
    if (running) return running;
    controller = new AbortController();
    running = run(controller.signal)
      .then(
        (result) => {
          try {
            void Promise.resolve(d.onResult?.(Object.freeze({ ...result }))).catch(() => undefined);
          } catch {
            /* Observer only. */
          }
          return result;
        },
        (error) => {
          try {
            void Promise.resolve(d.onUnavailable?.()).catch(() => undefined);
          } catch {
            /* Observer only. */
          }
          throw error;
        }
      )
      .finally(() => {
        running = undefined;
        controller = undefined;
      });
    return running;
  };
  const launch = () => {
    // Anchor to dispatch START, never completion. A slow admitted pass is
    // single-flight, with no catch-up fanout or accumulating timer queue.
    nextStart =
      performance.now() +
      MCP_OAUTH_LIMITS.poll_ms +
      Math.floor(Math.random() * (MCP_OAUTH_LIMITS.jitter_ms + 1));
    void runOnce()
      .catch(() => undefined)
      .finally(schedule);
  };
  const schedule = () => {
    if (!enabled || timer !== undefined) return;
    timer = setTimeout(
      () => {
        timer = undefined;
        launch();
      },
      Math.max(0, nextStart - performance.now())
    );
    timer.unref();
  };
  return {
    runOnce,
    start() {
      if (!enabled) {
        enabled = true;
        launch();
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
