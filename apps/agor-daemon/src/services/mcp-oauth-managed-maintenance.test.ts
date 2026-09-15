import { MCP_OAUTH_DISABLED_FLAGS } from '@agor/core/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createManagedOAuthMaintenance,
  type ManagedOAuthMaintenanceDependencies,
} from './mcp-oauth-managed-maintenance';

const routing = vi.hoisted(() => vi.fn());
vi.mock('@agor/core/db', async () => ({
  ...(await vi.importActual<object>('@agor/core/db')),
  listManagedOAuthMaintenanceTenants: routing,
  runWithSystemDatabaseScope: async (
    db: unknown,
    _reason: unknown,
    work: (db: unknown) => unknown
  ) => work(db),
}));
const capability = {
  protocol_version: 1,
  binding_version: 1,
  enforcement_version: 1,
  available: false,
  environment: 'staging',
  residency_region: 'us-west-2',
  recovery_incarnation: 'R'.repeat(43),
  profile_versions: [],
  flags: { ...MCP_OAUTH_DISABLED_FLAGS, revocation: true },
};
function fixture() {
  const starts: number[] = [];
  const onResult = vi.fn();
  const onUnavailable = vi.fn();
  const d: ManagedOAuthMaintenanceDependencies = {
    db: {} as ManagedOAuthMaintenanceDependencies['db'],
    masterSecret: 'synthetic-unused',
    sender: { request: vi.fn() },
    cellId: 'synthetic-cell',
    clock: { latestUtcMs: () => Date.now() },
    getCapabilities: async () => {
      starts.push(performance.now());
      return capability;
    },
    getCurrentIncarnation: async () => capability.recovery_incarnation,
    assertCleanupAdmission: async () => {},
    acknowledge: async () => {},
    onResult,
    onUnavailable,
  };
  return { d, starts, onResult, onUnavailable };
}
describe('managed maintenance cadence and aggregate observability', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
    routing.mockReset().mockResolvedValue({ tenantIds: [], nextCursor: null });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
  it.each([0, 0.999999])(
    'anchors starts to 30–35 seconds, not completion plus another interval (%s)',
    async (random) => {
      vi.spyOn(Math, 'random').mockReturnValue(random);
      const f = fixture();
      routing.mockImplementation(
        () =>
          new Promise((resolve) =>
            setTimeout(() => resolve({ tenantIds: [], nextCursor: null }), 20000)
          )
      );
      const worker = createManagedOAuthMaintenance(f.d);
      const interval = random === 0 ? 30000 : 35000;
      worker.start();
      expect(f.starts).toEqual([0]);
      await vi.advanceTimersByTimeAsync(20000);
      expect(f.onResult).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(interval - 20000);
      expect(f.starts).toEqual([0, interval]);
      await vi.advanceTimersByTimeAsync(20000);
      await worker.stop();
    }
  );
  it('never overlaps or accumulates catch-up passes when a dependency violates its budget', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const f = fixture();
    let release!: () => void;
    routing.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ tenantIds: [], nextCursor: null });
        })
    );
    const worker = createManagedOAuthMaintenance(f.d);
    worker.start();
    await vi.advanceTimersByTimeAsync(150000);
    expect(f.starts).toEqual([0]);
    const stopping = worker.stop();
    release();
    await stopping;
    expect(f.onResult).toHaveBeenCalledWith(expect.objectContaining({ capacityLimited: true }));
    await vi.advanceTimersByTimeAsync(150000);
    expect(f.starts).toEqual([0]);
  });
  it('ignores throwing/rejecting aggregate observers and reports unavailability without identities', async () => {
    const f = fixture();
    f.onResult.mockImplementation(() => {
      throw new Error('synthetic metrics failure');
    });
    const worker = createManagedOAuthMaintenance(f.d);
    await expect(worker.runOnce()).resolves.toMatchObject({ tenants: 0, failures: 0 });
    expect(Object.keys(f.onResult.mock.calls[0][0]).sort()).toEqual([
      'acknowledged',
      'capacityLimited',
      'closed',
      'failures',
      'reconciled',
      'tenants',
    ]);
    f.d.getCapabilities = async () => {
      throw new Error('synthetic unavailable');
    };
    f.onUnavailable.mockRejectedValue(new Error('synthetic metrics failure'));
    await expect(worker.runOnce()).rejects.toThrow('synthetic unavailable');
    expect(f.onUnavailable).toHaveBeenCalledWith();
    await worker.stop();
  });
});
