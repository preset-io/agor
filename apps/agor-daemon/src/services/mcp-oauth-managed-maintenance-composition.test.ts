import type { AgorConfig } from '@agor/core/config';
import type { MCPManagedOAuthGrantMetadata } from '@agor/core/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import projection from '../../../../packages/core/src/tools/mcp/__fixtures__/managed-v1/projection-results.json';
import valid from '../../../../packages/core/src/tools/mcp/__fixtures__/managed-v1/valid.json';
import { loadManagedOAuthCleanupDeployment } from '../mcp-egress/managed-deployment.js';
import { managedOAuthReceiptCommitFence } from './mcp-oauth-managed-ack.js';
import type { ManagedOAuthMaintenanceDependencies } from './mcp-oauth-managed-maintenance.js';
import { createManagedOAuthMaintenanceServices } from './mcp-oauth-managed-maintenance-composition.js';

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
