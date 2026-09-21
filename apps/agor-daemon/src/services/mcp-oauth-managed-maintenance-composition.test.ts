import type { AgorConfig } from '@agor/core/config';
import type { MCPManagedOAuthGrantMetadata } from '@agor/core/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import projection from '../../../../packages/core/src/tools/mcp/__fixtures__/managed-v1/projection-results.json';
import valid from '../../../../packages/core/src/tools/mcp/__fixtures__/managed-v1/valid.json';
import { loadManagedOAuthCleanupDeployment } from '../mcp-egress/managed-deployment.js';
import { managedOAuthReceiptCommitFence } from './mcp-oauth-managed-authority.js';
import { createManagedOAuthMaintenanceServices } from './mcp-oauth-managed-composition.js';
import type { ManagedOAuthMaintenanceDependencies } from './mcp-oauth-managed-maintenance.js';

const state = vi.hoisted(() => ({
  deps: undefined as ManagedOAuthMaintenanceDependencies | undefined,
}));
vi.mock('../mcp-egress/managed-deployment.js', () => ({
  loadManagedOAuthCleanupDeployment: vi.fn(),
}));
vi.mock('./mcp-oauth-managed-maintenance.js', () => ({
  createManagedOAuthMaintenance: (deps: ManagedOAuthMaintenanceDependencies) => {
    state.deps = deps;
    return { start: vi.fn(), stop: vi.fn() };
  },
}));
const options = () => ({
  db: {} as Parameters<typeof createManagedOAuthMaintenanceServices>[0]['db'],
  config: {
    managed_mcp_oauth: {
      enabled: false,
      revocation: true,
      cell_id: valid.owner.cell_id,
      environment: valid.owner.environment,
      region: valid.owner.residency_region,
    },
  } as AgorConfig,
  externalLaunchProvider: {} as Parameters<
    typeof createManagedOAuthMaintenanceServices
  >[0]['externalLaunchProvider'],
});
let now: number;
let request: ReturnType<typeof vi.fn>;
let capabilities: typeof projection.valid.capabilities;
beforeEach(() => {
  vi.stubEnv('AGOR_MASTER_SECRET', 'synthetic-disposable-master');
  state.deps = undefined;
  now = 1000;
  capabilities = {
    ...structuredClone(projection.valid.capabilities),
    available: false,
    profile_versions: [],
    recovery_incarnation: valid.owner.recovery_incarnation,
  };
  request = vi.fn(async (input) =>
    input.operation === 'capabilities'
      ? structuredClone(capabilities)
      : { protocol_version: 1, acknowledged: true }
  );
  vi.mocked(loadManagedOAuthCleanupDeployment).mockResolvedValue({
    clock: { latestUtcMs: () => now },
    sender: { request },
    issuer: 'https://worker.example/',
    identity: { provider: 'cloud', issuer: 'https://cloud.example/' },
  } as unknown as NonNullable<Awaited<ReturnType<typeof loadManagedOAuthCleanupDeployment>>>);
});

afterEach(() => vi.unstubAllEnvs());

describe('production maintenance composition', () => {
  it('does not restart the send budget after a capabilities round trip', async () => {
    let elapsed = 0;
    const monotonic = vi.spyOn(performance, 'now').mockImplementation(() => elapsed);
    try {
      await createManagedOAuthMaintenanceServices(options());
      request.mockImplementation(async (input) => {
        if (input.operation === 'capabilities') {
          elapsed += 3000;
          return capabilities;
        }
        return {};
      });
      await state.deps!.sender.request({ operation: 'close', timeoutMs: 5000 } as never);
      expect(request.mock.calls.at(-1)![0].timeoutMs).toBe(2000);
      now += 1000;
      elapsed = 0;
      request.mockClear();
      await expect(
        state.deps!.sender.request({ operation: 'close', timeoutMs: 2000 } as never)
      ).rejects.toThrow();
      expect(request.mock.calls.map(([input]) => input.operation)).toEqual(['capabilities']);
    } finally {
      monotonic.mockRestore();
    }
  });
  it('emits bounded aggregate-only backlog and availability metrics', async () => {
    const metrics = { increment: vi.fn(), gauge: vi.fn() };
    await createManagedOAuthMaintenanceServices({ ...options(), metrics });
    state.deps!.onResult!({
      tenants: 1,
      reconciled: 2,
      acknowledged: 3,
      closed: 4,
      failures: 5,
      capacityLimited: true,
    });
    state.deps!.onUnavailable!();
    expect(metrics.increment.mock.calls).toEqual([
      ['mcp.managed_maintenance', 2, { operation: 'reconciled' }],
      ['mcp.managed_maintenance', 3, { operation: 'acknowledged' }],
      ['mcp.managed_maintenance', 4, { operation: 'closed' }],
      ['mcp.managed_maintenance', 5, { operation: 'failures' }],
    ]);
    expect(metrics.gauge.mock.calls).toEqual([
      ['mcp.managed_maintenance_capacity_limited', 1],
      ['mcp.managed_maintenance_unavailable', 0],
      ['mcp.managed_maintenance_unavailable', 1],
    ]);
  });
  it('is entirely inert with both flags off', async () => {
    vi.mocked(loadManagedOAuthCleanupDeployment).mockClear();
    const input = options();
    input.config.managed_mcp_oauth!.revocation = false;
    expect(await createManagedOAuthMaintenanceServices(input)).toBeNull();
    expect(loadManagedOAuthCleanupDeployment).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });
  it('admits exact-old cleanup with master off and no vending profiles', async () => {
    await createManagedOAuthMaintenanceServices(options());
    expect(state.deps!.runtime).toBeUndefined();
    await expect(state.deps!.assertCleanupAdmission(valid.owner)).resolves.toBeUndefined();
    await expect(state.deps!.getCurrentIncarnation()).resolves.toBe(
      valid.owner.recovery_incarnation
    );
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('refuses old incarnation, foreign cell and provider vending requests', async () => {
    await createManagedOAuthMaintenanceServices(options());
    await expect(
      state.deps!.assertCleanupAdmission({ ...valid.owner, recovery_incarnation: 'X'.repeat(43) })
    ).rejects.toThrow();
    await expect(
      state.deps!.assertCleanupAdmission({ ...valid.owner, cell_id: 'foreign' })
    ).rejects.toThrow();
    await expect(state.deps!.sender.request({ operation: 'prepare' } as never)).rejects.toThrow();
    expect(request.mock.calls.every(([input]) => input.operation === 'capabilities')).toBe(true);
  });
  it('all concurrent capability consumers reject a substituted environment', async () => {
    capabilities.environment = 'production';
    await createManagedOAuthMaintenanceServices(options());
    const results = await Promise.allSettled([
      state.deps!.getCapabilities(),
      state.deps!.getCurrentIncarnation(),
    ]);
    expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected']);
  });
  it('does not reuse a failed or expired recovery snapshot', async () => {
    await createManagedOAuthMaintenanceServices(options());
    await state.deps!.getCapabilities();
    now += 1000;
    request.mockRejectedValue(new Error('SENTINEL_PRIVATE'));
    await expect(state.deps!.getCurrentIncarnation()).rejects.toThrow();
  });
  it('keeps ACK identity stable after a certified sequence-only rejection', () => {
    const metadata = {
      owner: valid.owner,
      receipt_id: valid.succeeded.receipt_id,
      operation_id: valid.succeeded.operation_id,
      next_sequence: '1',
      receipt_claims: { next_sequence: '1' },
    } as MCPManagedOAuthGrantMetadata;
    expect(managedOAuthReceiptCommitFence(metadata)).toBe(
      managedOAuthReceiptCommitFence({ ...metadata, next_sequence: '2' })
    );
    expect(managedOAuthReceiptCommitFence(metadata)).not.toBe(
      managedOAuthReceiptCommitFence({ ...metadata, receipt_id: 'another' })
    );
  });
});
