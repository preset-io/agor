/** Nonvending cleanup survives a master switch-off, never a recovery-incarnation change. */
import { randomUUID } from 'node:crypto';
import type { AgorConfig, ResolvedExternalLaunchProvider } from '@agor/core/config';
import type { TenantScopeAwareDatabase } from '@agor/core/db';
import type { ManagedMCPOAuthClient } from '@agor/core/tools/mcp/managed-oauth-client';
import {
  McpOAuthCapabilitiesSchema,
  McpOAuthCapabilityRequestSchema,
  type McpOAuthOwner,
} from '@agor/core/types';
import { loadManagedOAuthCleanupDeployment } from '../mcp-egress/managed-deployment.js';
import type { DaemonMetrics } from '../metrics/types.js';
import { createManagedOAuthAcknowledger } from './mcp-oauth-managed-ack.js';
import type { ManagedOAuthServices } from './mcp-oauth-managed-composition.js';
import { createManagedOAuthMaintenance } from './mcp-oauth-managed-maintenance.js';
import { ManagedOAuthUnavailableError } from './mcp-oauth-managed-runtime.js';

export async function createManagedOAuthMaintenanceServices(input: {
  db: TenantScopeAwareDatabase;
  config: AgorConfig;
  externalLaunchProvider: ResolvedExternalLaunchProvider;
  active?: ManagedOAuthServices;
  metrics?: Pick<DaemonMetrics, 'increment' | 'gauge'>;
}) {
  if (!input.active && input.config.managed_mcp_oauth?.revocation !== true) return null;
  const cleanup = await loadManagedOAuthCleanupDeployment(input.config, {
    externalLaunchProvider: input.externalLaunchProvider,
  });
  const deployment = cleanup ?? input.active?.deployment;
  const settings = Object.freeze({ ...input.config.managed_mcp_oauth });
  const masterSecret = process.env.AGOR_MASTER_SECRET;
  if (!deployment || !masterSecret || !settings.cell_id) throw new ManagedOAuthUnavailableError();
  const rawSender = deployment.sender;
  type Capabilities = ReturnType<typeof McpOAuthCapabilitiesSchema.parse>;
  let snapshot: { value: Capabilities; at: number } | undefined;
  let inFlight: Promise<Capabilities> | undefined;
  const getCapabilities = async (budget?: {
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<Capabilities> => {
    if (budget?.signal?.aborted || (budget?.timeoutMs !== undefined && budget.timeoutMs <= 0))
      throw new ManagedOAuthUnavailableError();
    const deadline = performance.now() + Math.min(10000, budget?.timeoutMs ?? 10000);
    const now = deployment.clock.latestUtcMs();
    if (snapshot && now >= snapshot.at && now - snapshot.at < 1000)
      return structuredClone(snapshot.value);
    if (inFlight) return structuredClone(await inFlight);
    // One-second fanout coalescing only. The worker rechecks external recovery authority
    // on EVERY operation; expired/failed capability reads are never an allowing fallback.
    snapshot = undefined;
    inFlight = (async () => {
      const value = await rawSender.request({
        operation: 'capabilities',
        body: McpOAuthCapabilityRequestSchema.parse({
          protocol_version: 1,
          operation_id: randomUUID(),
        }),
        schema: McpOAuthCapabilitiesSchema,
        recovery: true,
        timeoutMs: Math.max(1, Math.floor(deadline - performance.now())),
        assertCurrent: () => {
          if (budget?.signal?.aborted || performance.now() >= deadline)
            throw new ManagedOAuthUnavailableError();
          deployment.clock.latestUtcMs();
        },
      });
      if (
        value.environment !== settings.environment ||
        value.residency_region !== settings.region ||
        !value.recovery_incarnation
      )
        throw new ManagedOAuthUnavailableError();
      snapshot = { value, at: now };
      return value;
    })();
    try {
      return structuredClone(await inFlight);
    } finally {
      inFlight = undefined;
    }
  };
  const getCurrentIncarnation = async (budget?: { timeoutMs?: number; signal?: AbortSignal }) => {
    const value = (await getCapabilities(budget)).recovery_incarnation;
    if (!value) throw new ManagedOAuthUnavailableError();
    return value;
  };
  const assertOwner = async (
    owner: McpOAuthOwner,
    budget?: { timeoutMs?: number; signal?: AbortSignal }
  ) => {
    deployment.clock.latestUtcMs();
    if (
      owner.cell_id !== settings.cell_id ||
      owner.environment !== settings.environment ||
      owner.residency_region !== settings.region ||
      owner.recovery_incarnation !== (await getCurrentIncarnation(budget))
    )
      throw new ManagedOAuthUnavailableError();
    // Do not require a still-existing local user/server or current placement/cohort for exact-old cleanup.
  };
  const sender: Pick<ManagedMCPOAuthClient, 'request'> = {
    request: (async (request) => {
      const deadline = performance.now() + Math.min(10000, request.timeoutMs ?? 10000);
      const remaining = () => {
        const value = Math.floor(deadline - performance.now());
        if (value <= 0) throw new ManagedOAuthUnavailableError();
        return value;
      };
      if (
        !['cancel', 'cancel_reservation', 'close', 'cleanup', 'ack', 'capabilities'].includes(
          request.operation
        )
      )
        throw new ManagedOAuthUnavailableError();
      if (
        ['cancel', 'cancel_reservation', 'close', 'cleanup'].includes(request.operation) &&
        (settings.revocation !== true ||
          !(await getCapabilities({ timeoutMs: remaining() })).flags.revocation)
      )
        throw new ManagedOAuthUnavailableError();
      return rawSender.request({ ...request, timeoutMs: remaining() });
    }) as ManagedMCPOAuthClient['request'],
  };
  return createManagedOAuthMaintenance({
    db: input.db,
    masterSecret,
    runtime: input.active?.runtime,
    sender,
    clock: deployment.clock,
    cellId: settings.cell_id,
    getCapabilities,
    getCurrentIncarnation,
    assertCleanupAdmission: assertOwner,
    acknowledge: createManagedOAuthAcknowledger({ sender, assertOwner }),
    onResult: (result) => {
      // No tenant, subject, handle, URL, exception or credential becomes a metric tag.
      for (const operation of ['reconciled', 'acknowledged', 'closed', 'failures'] as const) {
        input.metrics?.increment('mcp.managed_maintenance', result[operation], { operation });
      }
      input.metrics?.gauge(
        'mcp.managed_maintenance_capacity_limited',
        Number(result.capacityLimited)
      );
      input.metrics?.gauge('mcp.managed_maintenance_unavailable', 0);
    },
    onUnavailable: () => input.metrics?.gauge('mcp.managed_maintenance_unavailable', 1),
  });
}
