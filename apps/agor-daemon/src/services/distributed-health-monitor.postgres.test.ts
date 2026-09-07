import { EventEmitter } from 'node:events';
import {
  BranchRepository,
  createDatabase,
  createTenantScopedDatabaseProxy,
  type Database,
  EnvironmentHealthRepository,
  generateId,
  initializeDatabase,
  RepoRepository,
  runWithTenantDatabaseScope,
  type TenantScopeAwareDatabase,
  UsersRepository,
} from '@agor/core/db';
import type { BranchID, TenantID } from '@agor/core/types';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  DistributedHealthMonitor,
  type DistributedHealthMonitorOptions,
} from './distributed-health-monitor.js';

const postgresUrl = process.env.AGOR_TEST_POSTGRES_URL;
const usesPostgresSchema = process.env.AGOR_DB_DIALECT === 'postgresql';
let branchUnique = (Date.now() % 1_000_000) + 9_000_000;

function makeApp() {
  const branches = new EventEmitter();
  return { app: { service: () => branches }, branches };
}

function monitorOptions(
  tenantId: TenantID,
  branchId: BranchID,
  overrides: Partial<DistributedHealthMonitorOptions> = {}
): DistributedHealthMonitorOptions {
  return {
    workIdentity: { instanceId: `daemon-${generateId()}`, bootId: `boot-${generateId()}` },
    scanIntervalMs: 50,
    maxIdleIntervalMs: 500,
    startupOffsetMaxMs: 0,
    scanBatchSize: 8,
    maxInFlight: 2,
    httpTimeoutMs: 1_000,
    claimLeaseMs: 6_000,
    shutdownDrainTimeoutMs: 1_000,
    discover: async () => [{ tenant_id: tenantId, branch_id: branchId }],
    ...overrides,
  };
}

async function seedBranch(
  db: TenantScopeAwareDatabase,
  tenantId: TenantID,
  status: 'starting' | 'running' = 'running'
) {
  return runWithTenantDatabaseScope(db, tenantId, async (scoped) => {
    const user = await new UsersRepository(scoped).create({
      email: `${tenantId}-${generateId()}@example.com`,
      name: 'Distributed health monitor',
    });
    const repo = await new RepoRepository(scoped).create({
      repo_id: generateId(),
      slug: `distributed-health-${generateId()}`,
      name: 'Distributed health monitor',
      repo_type: 'remote',
      remote_url: 'https://example.invalid/health.git',
      local_path: `/tmp/${generateId()}`,
      default_branch: 'main',
    });
    return new BranchRepository(scoped).create({
      branch_id: generateId() as BranchID,
      repo_id: repo.repo_id,
      name: `distributed-health-${generateId()}`,
      ref: 'main',
      branch_unique_id: branchUnique++,
      path: `/tmp/${generateId()}`,
      created_by: user.user_id,
      health_check_url: 'https://example.invalid/health',
      environment_instance: { status },
    });
  });
}

describe.skipIf(!postgresUrl || !usesPostgresSchema)(
  'DistributedHealthMonitor (two PostgreSQL repositories)',
  () => {
    let rawA: Database;
    let rawB: Database;
    let dbA: TenantScopeAwareDatabase;
    let dbB: TenantScopeAwareDatabase;

    beforeAll(async () => {
      rawA = createDatabase({ dialect: 'postgresql', url: postgresUrl! });
      rawB = createDatabase({ dialect: 'postgresql', url: postgresUrl! });
      await initializeDatabase(rawA);
      dbA = createTenantScopedDatabaseProxy(rawA, { requireScope: true });
      dbB = createTenantScopedDatabaseProxy(rawB, { requireScope: true });
    });

    afterAll(async () => {
      await Promise.all([
        (rawA as Database & { $client: { end: () => Promise<void> } }).$client.end(),
        (rawB as Database & { $client: { end: () => Promise<void> } }).$client.end(),
      ]);
    });

    it('allows one live HTTP check across two apps and periodic discovery recovers a missed event', async () => {
      const tenantId = `worker-owner-${generateId()}` as TenantID;
      const branch = await seedBranch(dbA, tenantId);
      let releaseFetch: (() => void) | undefined;
      const fetchHealth = vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            releaseFetch = () => resolve(new Response('', { status: 200 }));
          })
      );
      const appA = makeApp();
      const appB = makeApp();
      const monitorA = new DistributedHealthMonitor(
        appA.app as never,
        dbA,
        monitorOptions(tenantId, branch.branch_id, { fetchHealth })
      );
      const monitorB = new DistributedHealthMonitor(
        appB.app as never,
        dbB,
        monitorOptions(tenantId, branch.branch_id, { fetchHealth })
      );

      // No branch event is emitted. Both bounded scans still discover the row;
      // the live lease admits exactly one concurrent outbound request.
      const scans = Promise.all([monitorA.checkOnce(), monitorB.checkOnce()]);
      await vi.waitFor(() => expect(fetchHealth).toHaveBeenCalledTimes(1));
      releaseFetch?.();
      const results = await scans;
      expect(results.reduce((sum, result) => sum + result.claimed, 0)).toBe(1);
      expect(
        await runWithTenantDatabaseScope(dbA, tenantId, (scoped) =>
          new BranchRepository(scoped).findById(branch.branch_id)
        )
      ).toMatchObject({
        environment_instance: { status: 'running', last_health_check: { status: 'healthy' } },
      });
      await Promise.all([monitorA.cleanup(), monitorB.cleanup()]);
    });

    it('coordinates repeated unrecorded startup failures without errors or realtime events', async () => {
      const tenantId = `worker-starting-${generateId()}` as TenantID;
      const branch = await seedBranch(dbA, tenantId, 'starting');
      const fetchHealth = vi.fn(async () => {
        throw new Error('Health endpoint unreachable');
      });
      const appA = makeApp();
      const appB = makeApp();
      const emitA = vi.spyOn(appA.branches, 'emit');
      const emitB = vi.spyOn(appB.branches, 'emit');
      // Keep the cooldown comfortably above loaded-CI PostgreSQL round-trip
      // time. The assertion below is about durable coordination, not whether
      // two setup/check transactions happen to finish inside the 50 ms default.
      const scanIntervalMs = 1_000;
      const maxIdleIntervalMs = 2_000;
      const monitorA = new DistributedHealthMonitor(
        appA.app as never,
        dbA,
        monitorOptions(tenantId, branch.branch_id, {
          fetchHealth,
          scanIntervalMs,
          maxIdleIntervalMs,
        })
      );
      const monitorB = new DistributedHealthMonitor(
        appB.app as never,
        dbB,
        monitorOptions(tenantId, branch.branch_id, {
          fetchHealth,
          scanIntervalMs,
          maxIdleIntervalMs,
        })
      );

      const first = await Promise.all([monitorA.checkOnce(), monitorB.checkOnce()]);
      expect(first.reduce((sum, result) => sum + result.claimed, 0)).toBe(1);
      expect(first.reduce((sum, result) => sum + result.committed, 0)).toBe(1);
      expect(first.reduce((sum, result) => sum + result.failures, 0)).toBe(0);

      // The durable cooldown prevents event hints or a second replica from
      // turning one expected startup failure into a tight retry loop.
      const duringCooldown = await Promise.all([monitorA.checkOnce(), monitorB.checkOnce()]);
      expect(duringCooldown.reduce((sum, result) => sum + result.claimed, 0)).toBe(0);
      expect(duringCooldown.reduce((sum, result) => sum + result.failures, 0)).toBe(0);
      expect(fetchHealth).toHaveBeenCalledOnce();

      await new Promise((resolve) => setTimeout(resolve, scanIntervalMs + 100));
      const nextInterval = await Promise.all([monitorA.checkOnce(), monitorB.checkOnce()]);
      expect(nextInterval.reduce((sum, result) => sum + result.committed, 0)).toBe(1);
      expect(nextInterval.reduce((sum, result) => sum + result.failures, 0)).toBe(0);
      expect(fetchHealth).toHaveBeenCalledTimes(2);
      expect(
        await runWithTenantDatabaseScope(dbA, tenantId, (scoped) =>
          new BranchRepository(scoped).findById(branch.branch_id)
        )
      ).toMatchObject({ environment_instance: { status: 'starting' } });
      expect(
        (
          await runWithTenantDatabaseScope(dbA, tenantId, (scoped) =>
            new BranchRepository(scoped).findById(branch.branch_id)
          )
        )?.environment_instance?.last_health_check
      ).toBeUndefined();
      expect(emitA).not.toHaveBeenCalled();
      expect(emitB).not.toHaveBeenCalled();

      await Promise.all([monitorA.cleanup(), monitorB.cleanup()]);
    });

    it('aborts and drains shutdown work, releases only the owned claim, and permits takeover', async () => {
      const tenantId = `worker-shutdown-${generateId()}` as TenantID;
      const branch = await seedBranch(dbA, tenantId);
      const fetchHealth = vi.fn(
        (_url: string | URL | Request, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
              once: true,
            });
          })
      );
      const app = makeApp();
      const monitor = new DistributedHealthMonitor(
        app.app as never,
        dbA,
        monitorOptions(tenantId, branch.branch_id, { fetchHealth })
      );
      const scan = monitor.checkOnce();
      await vi.waitFor(() => expect(fetchHealth).toHaveBeenCalledOnce());
      await monitor.cleanup();
      await scan;
      await expect(monitor.checkOnce()).resolves.toMatchObject({
        candidates: 0,
        claimed: 0,
        committed: 0,
      });
      expect(fetchHealth).toHaveBeenCalledOnce();

      const takeover = await runWithTenantDatabaseScope(dbB, tenantId, (scoped) =>
        new EnvironmentHealthRepository(scoped).claim({
          branchId: branch.branch_id,
          claimToken: 'shutdown-takeover',
          leaseDurationMs: 6_000,
          identity: { instanceId: 'daemon-b', bootId: 'boot-b' },
        })
      );
      expect(takeover).toMatchObject({ outcome: 'claimed' });
      expect(monitor.getStatus()).toMatchObject({ shutdownRequested: true, inFlight: 0 });
    });
  }
);
