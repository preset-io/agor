import {
  boundedBackoffDelay,
  type DistributedWorkIdentity,
  initialWorkOffset,
  jitterDelay,
} from '@agor/core/coordination';
import {
  BranchRepository,
  type EnvironmentHealthClaim,
  EnvironmentHealthDiscoveryRepository,
  type EnvironmentHealthObservation,
  EnvironmentHealthRepository,
  type EnvironmentHealthRoutingCursor,
  enqueueAfterTenantDatabaseCommit,
  generateId,
  getHiddenTenantId,
  runWithoutTenantContext,
  runWithoutTenantDatabaseScope,
  runWithSystemDatabaseScope,
  runWithTenantContext,
  runWithTenantDatabaseScope,
  type TenantScopeAwareDatabase,
} from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import type { Branch, BranchID, TenantID } from '@agor/core/types';
import { createPinnedFetch } from '@agor/core/utils/pinned-fetch';
import { isAllowedFactProbeUrl, isAllowedHealthCheckUrl } from '@agor/core/utils/url';
import { emitServiceEvent } from '../utils/emit-service-event.js';

export interface DistributedHealthMonitorOptions {
  workIdentity: DistributedWorkIdentity;
  scanIntervalMs: number;
  maxIdleIntervalMs: number;
  startupOffsetMaxMs: number;
  scanBatchSize: number;
  maxInFlight: number;
  httpTimeoutMs: number;
  claimLeaseMs: number;
  shutdownDrainTimeoutMs: number;
  random?: () => number;
  generateClaimToken?: () => string;
  fetchHealth?: typeof fetch;
  fetchDynamicHealth?: ReturnType<typeof createPinnedFetch>;
  /** Test seam; production always uses capability-scoped PostgreSQL discovery. */
  discover?: (
    after?: EnvironmentHealthRoutingCursor
  ) => Promise<Array<{ branch_id: BranchID; tenant_id: TenantID }>>;
}

export interface DistributedHealthMonitorStats {
  candidates: number;
  claimed: number;
  committed: number;
  failures: number;
  saturated: boolean;
  traversalCompleted: boolean;
}

const MIN_CLAIM_WRITE_MARGIN_MS = 5_000;

function emptyStats(): DistributedHealthMonitorStats {
  return {
    candidates: 0,
    claimed: 0,
    committed: 0,
    failures: 0,
    saturated: false,
    traversalCompleted: false,
  };
}

function tenantParams(tenantId: TenantID | string) {
  return { tenant: { tenant_id: tenantId as TenantID, source: 'explicit' as const } };
}

/**
 * All-daemon bounded discovery plus per-branch PostgreSQL observation claims.
 * Branch events only wake the scanner; database claims/generations own safety.
 */
export class DistributedHealthMonitor {
  private timer: NodeJS.Timeout | null = null;
  private activeRun: Promise<void> | null = null;
  private started = false;
  private running = false;
  private shutdownRequested = false;
  private rerunRequested = false;
  private coordinationReady = false;
  private idleRounds = 0;
  private cursor: EnvironmentHealthRoutingCursor | undefined;
  private readonly random: () => number;
  private readonly generateClaimToken: () => string;
  private readonly fetchHealth: typeof fetch;
  private readonly fetchDynamicHealth: ReturnType<typeof createPinnedFetch>;
  private readonly activeClaims = new Map<
    string,
    { tenantId: TenantID; claim: EnvironmentHealthClaim }
  >();
  private readonly inFlight = new Map<
    string,
    { controller: AbortController; work: Promise<boolean> }
  >();

  private readonly onBranchHint = () => this.wake();

  constructor(
    private readonly app: Application,
    private readonly db: TenantScopeAwareDatabase,
    private readonly options: DistributedHealthMonitorOptions
  ) {
    this.random = options.random ?? Math.random;
    this.generateClaimToken = options.generateClaimToken ?? generateId;
    this.fetchHealth = options.fetchHealth ?? fetch;
    this.fetchDynamicHealth =
      options.fetchDynamicHealth ??
      createPinnedFetch({
        timeoutMs: options.httpTimeoutMs,
        maxBytes: 64 * 1024,
        isBodyComplete: () => true,
      });
    for (const [value, label] of [
      [options.scanIntervalMs, 'scan interval'],
      [options.maxIdleIntervalMs, 'maximum idle interval'],
      [options.scanBatchSize, 'scan batch size'],
      [options.maxInFlight, 'maximum in-flight'],
      [options.httpTimeoutMs, 'HTTP timeout'],
      [options.claimLeaseMs, 'claim lease'],
      [options.shutdownDrainTimeoutMs, 'shutdown drain timeout'],
    ] as const) {
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error(`Distributed environment health ${label} must be a positive integer`);
      }
    }
    if (!Number.isSafeInteger(options.startupOffsetMaxMs) || options.startupOffsetMaxMs < 0) {
      throw new Error('Distributed environment health startup offset must be non-negative');
    }
    if (options.maxIdleIntervalMs < options.scanIntervalMs) {
      throw new Error(
        'Distributed environment health maximum idle interval cannot be below scan interval'
      );
    }
    if (options.maxInFlight > options.scanBatchSize) {
      throw new Error(
        'Distributed environment health maximum in-flight cannot exceed scan batch size'
      );
    }
    if (options.scanBatchSize > 1_000) {
      throw new Error('Distributed environment health scan batch size cannot exceed 1000');
    }
    if (options.claimLeaseMs < options.httpTimeoutMs + MIN_CLAIM_WRITE_MARGIN_MS) {
      throw new Error(
        'Distributed environment health claim lease must leave at least 5000ms after its HTTP timeout'
      );
    }
  }

  isReady(): boolean {
    return this.started && !this.shutdownRequested && this.coordinationReady;
  }

  getStatus() {
    return {
      started: this.started,
      shutdownRequested: this.shutdownRequested,
      coordinationReady: this.coordinationReady,
      inFlight: this.inFlight.size,
      ownedClaims: this.activeClaims.size,
      cursor: this.cursor,
    };
  }

  async initialize(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.shutdownRequested = false;
    const branches = this.app.service('branches');
    branches.on('created', this.onBranchHint);
    branches.on('patched', this.onBranchHint);
    branches.on('removed', this.onBranchHint);
    const initialDelayMs = initialWorkOffset(this.options.startupOffsetMaxMs, this.random());
    console.log(
      `[distributed-work.environment-health] event="loop_started" instance_id=${JSON.stringify(this.options.workIdentity.instanceId)} boot_id=${JSON.stringify(this.options.workIdentity.bootId)} scan_batch_size=${this.options.scanBatchSize} max_in_flight=${this.options.maxInFlight} initial_delay_ms=${initialDelayMs}`
    );
    // Validate the advertised discovery path immediately without claiming or
    // contacting an environment. Actual observation work honors the randomized
    // startup offset; a failure leaves readiness false and the loop retries.
    try {
      await this.discover();
      this.coordinationReady = true;
    } catch (error) {
      this.coordinationReady = false;
      this.logCoordinationFailure(error);
    }
    this.schedule(initialDelayMs);
  }

  wake(): void {
    const afterCommit = () => {
      runWithoutTenantContext(() =>
        runWithoutTenantDatabaseScope(() => {
          if (!this.started || this.shutdownRequested) return;
          if (this.running) {
            this.rerunRequested = true;
            return;
          }
          this.schedule(0, true);
        })
      );
    };
    if (!enqueueAfterTenantDatabaseCommit(afterCommit)) afterCommit();
  }

  private schedule(delayMs: number, replace = false): void {
    if (!this.started || this.shutdownRequested) return;
    if (this.timer) {
      if (!replace) return;
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      const run = this.runLoopIteration();
      this.activeRun = run;
      void run.finally(() => {
        if (this.activeRun === run) this.activeRun = null;
      });
    }, delayMs);
    this.timer.unref?.();
  }

  private logCoordinationFailure(error: unknown): void {
    console.warn(
      `[distributed-work.environment-health] event=coordination_unavailable instance_id=${JSON.stringify(this.options.workIdentity.instanceId)} boot_id=${JSON.stringify(this.options.workIdentity.bootId)} error=${JSON.stringify(error instanceof Error ? error.message : String(error))}`
    );
  }

  private async runLoopIteration(): Promise<void> {
    let stats = emptyStats();
    try {
      stats = await this.tick();
      this.coordinationReady = true;
      if (!stats.saturated) {
        this.idleRounds =
          stats.claimed === 0 && stats.failures === 0 && !stats.traversalCompleted
            ? this.idleRounds + 1
            : 0;
      }
    } catch (error) {
      this.coordinationReady = false;
      this.idleRounds += 1;
      this.logCoordinationFailure(error);
    }
    if (!this.started || this.shutdownRequested) return;
    if (this.rerunRequested) {
      this.rerunRequested = false;
      this.schedule(0, true);
      return;
    }
    const delay = stats.saturated
      ? jitterDelay(150, 2 / 3, this.random())
      : stats.claimed > 0 || stats.failures > 0 || stats.traversalCompleted
        ? jitterDelay(this.options.scanIntervalMs, 0.2, this.random())
        : boundedBackoffDelay(
            this.idleRounds,
            {
              baseDelayMs: this.options.scanIntervalMs,
              maxDelayMs: this.options.maxIdleIntervalMs,
              jitterRatio: 0.2,
            },
            this.random()
          );
    this.schedule(delay);
  }

  async tick(): Promise<DistributedHealthMonitorStats> {
    if (this.running) {
      this.rerunRequested = true;
      return emptyStats();
    }
    this.running = true;
    try {
      return await this.checkOnce();
    } finally {
      this.running = false;
    }
  }

  private async discover() {
    if (this.options.discover) return this.options.discover(this.cursor);
    return runWithSystemDatabaseScope(
      this.db,
      'Environment health observation discovery',
      (systemDb) =>
        new EnvironmentHealthDiscoveryRepository(systemDb).findActiveRefs({
          limit: this.options.scanBatchSize,
          ...(this.cursor ? { after: this.cursor } : {}),
        }),
      { capability: 'environment_health_discovery' }
    );
  }

  /** One bounded discovery/claim pass, exposed for deterministic HA tests. */
  async checkOnce(): Promise<DistributedHealthMonitorStats> {
    if (this.shutdownRequested) return emptyStats();
    const stats = emptyStats();

    const hadCursor = this.cursor !== undefined;
    const refs = await this.discover();
    if (refs.length === 0) {
      this.cursor = undefined;
      stats.traversalCompleted = hadCursor;
      return stats;
    }
    const last = refs.at(-1)!;
    const hasAnotherPage = refs.length >= this.options.scanBatchSize;
    this.cursor = hasAnotherPage
      ? { tenant_id: last.tenant_id, branch_id: last.branch_id }
      : undefined;
    stats.candidates = refs.length;
    stats.saturated = hasAnotherPage;
    stats.traversalCompleted = !hasAnotherPage;

    for (
      let index = 0;
      index < refs.length && !this.shutdownRequested;
      index += this.options.maxInFlight
    ) {
      const chunk = refs.slice(index, index + this.options.maxInFlight);
      // Await every child even when one tenant/endpoint fails. Otherwise the
      // next wake can overlap work whose parent iteration already rejected.
      const results = await Promise.allSettled(
        chunk.map((ref) => this.observeClaim(ref.tenant_id, ref.branch_id))
      );
      for (const result of results) {
        if (result.status === 'fulfilled') {
          stats.claimed += result.value.claimed;
          stats.committed += result.value.committed;
          stats.failures += result.value.failed;
        } else {
          stats.failures += 1;
          console.warn(
            `[distributed-work.environment-health] event=observation_failed instance_id=${JSON.stringify(this.options.workIdentity.instanceId)} boot_id=${JSON.stringify(this.options.workIdentity.bootId)} error=${JSON.stringify(result.reason instanceof Error ? result.reason.message : String(result.reason))}`
          );
        }
      }
    }
    return stats;
  }

  private claimKey(tenantId: TenantID | string, branchId: BranchID): string {
    return `${tenantId}\0${branchId}`;
  }

  private async observeClaim(tenantId: TenantID, branchId: BranchID) {
    if (this.shutdownRequested) return { claimed: 0, committed: 0, failed: 0 };
    const resourceKey = this.claimKey(tenantId, branchId);
    // Wakes are hints and may race shutdown/iteration boundaries. Never admit
    // a second local request for the same resource, even under the same token.
    if (this.activeClaims.has(resourceKey) || this.inFlight.has(resourceKey)) {
      return { claimed: 0, committed: 0, failed: 0 };
    }
    return runWithTenantContext(tenantId, async () => {
      const branch = await runWithTenantDatabaseScope(this.db, tenantId, (scopedDb) =>
        new BranchRepository(scopedDb).findById(branchId)
      );
      if (!branch) {
        return { claimed: 0, committed: 0, failed: 0 };
      }
      const rowTenantId = getHiddenTenantId(branch);
      if (rowTenantId && rowTenantId !== tenantId) {
        throw new Error(`Environment health tenant mismatch for branch ${branchId}`);
      }
      const claimToken = this.generateClaimToken();
      const claimResult = await runWithTenantDatabaseScope(this.db, tenantId, (scopedDb) =>
        new EnvironmentHealthRepository(scopedDb).claim({
          branchId,
          claimToken,
          leaseDurationMs: this.options.claimLeaseMs,
          identity: this.options.workIdentity,
        })
      );
      if (claimResult.outcome !== 'claimed') return { claimed: 0, committed: 0, failed: 0 };
      const claim = claimResult.claim;
      this.activeClaims.set(resourceKey, { tenantId, claim });
      console.log(
        `[distributed-work.environment-health] event=observation_claimed instance_id=${JSON.stringify(this.options.workIdentity.instanceId)} boot_id=${JSON.stringify(this.options.workIdentity.bootId)} tenant_id=${JSON.stringify(tenantId)} branch_id=${JSON.stringify(branchId)} claim_generation=${claim.claim_generation} environment_generation=${claim.environment_generation}`
      );

      const controller = new AbortController();
      const work = this.performClaimedObservation(tenantId, branch, claim, controller);
      this.inFlight.set(resourceKey, { controller, work });
      let observationCompleted = false;
      try {
        const observationCommitted = await work;
        observationCompleted = observationCommitted;
        return { claimed: 1, committed: observationCommitted ? 1 : 0, failed: 0 };
      } finally {
        // Claims are one observation wide. Paging therefore never accumulates
        // retained ownership or re-probes early pages; token equality makes a
        // best-effort release safe after takeover/lifecycle invalidation.
        await runWithTenantDatabaseScope(this.db, tenantId, (scopedDb) =>
          new EnvironmentHealthRepository(scopedDb).release(
            branchId,
            claim.claim_token,
            observationCompleted ? this.options.scanIntervalMs : undefined
          )
        ).catch(() => undefined);
        this.inFlight.delete(resourceKey);
        const active = this.activeClaims.get(resourceKey);
        if (active?.claim.claim_token === claim.claim_token) this.activeClaims.delete(resourceKey);
      }
    });
  }

  private async performClaimedObservation(
    tenantId: TenantID,
    branch: Branch,
    claim: EnvironmentHealthClaim,
    controller: AbortController
  ): Promise<boolean> {
    const renewed = await runWithTenantDatabaseScope(this.db, tenantId, (scopedDb) =>
      new EnvironmentHealthRepository(scopedDb).renew({
        branchId: branch.branch_id,
        claimToken: claim.claim_token,
        environmentGeneration: claim.environment_generation,
        leaseDurationMs: this.options.claimLeaseMs,
      })
    );
    if (!renewed || this.shutdownRequested) {
      this.activeClaims.delete(this.claimKey(tenantId, branch.branch_id));
      return false;
    }
    this.activeClaims.set(this.claimKey(tenantId, branch.branch_id), {
      tenantId,
      claim: renewed,
    });
    const observation = await this.fetchObservation(branch, controller);
    if (!observation || this.shutdownRequested) return false;
    const result = await runWithTenantDatabaseScope(this.db, tenantId, (scopedDb) =>
      new EnvironmentHealthRepository(scopedDb).commit({
        branchId: branch.branch_id,
        claimToken: claim.claim_token,
        environmentGeneration: claim.environment_generation,
        observation,
        // The startup budget is wall-clock, so the shared rules need this
        // monitor's actual cadence to convert it into a probe count.
        probeIntervalMs: this.options.scanIntervalMs,
      })
    );
    if (result.outcome !== 'committed') {
      this.activeClaims.delete(this.claimKey(tenantId, branch.branch_id));
      return false;
    }
    if (result.stateChanged) {
      const current = await runWithTenantDatabaseScope(this.db, tenantId, (scopedDb) =>
        new BranchRepository(scopedDb).findById(branch.branch_id)
      );
      if (current) {
        emitServiceEvent(this.app, {
          path: 'branches',
          event: 'patched',
          data: current,
          params: tenantParams(tenantId),
          id: branch.branch_id,
        });
      }
    }
    return true;
  }

  private async fetchObservation(
    branch: Branch,
    controller: AbortController
  ): Promise<EnvironmentHealthObservation | null> {
    // A REMOTE environment (a Codespace) has no frozen health_check_url — its
    // reachable address does not exist until the environment starts, so the
    // lifecycle command reports it as a `health` fact instead. Without this
    // fallback every remote environment is permanently "not observable" here
    // and can never leave `starting`, which is the whole Codespaces variant.
    //
    // Facts are command output, so the URL is untrusted input and gets the
    // stricter fact guard (blocks loopback/RFC1918/link-local/.internal) rather
    // than the plain health-check guard applied to operator-authored config.
    const rawFactsHealthUrl = branch.environment_instance?.facts?.health;
    const factsHealthUrl =
      rawFactsHealthUrl && isAllowedFactProbeUrl(rawFactsHealthUrl) ? rawFactsHealthUrl : undefined;
    const healthUrl = branch.health_check_url || factsHealthUrl;
    const isDynamicHealth = !branch.health_check_url && factsHealthUrl !== undefined;
    if (!healthUrl) {
      return {
        status: 'unknown',
        message: rawFactsHealthUrl
          ? 'Health fact points at a disallowed destination; environment health is not observable'
          : 'No health check configured; remote environment health is not observable',
        recordWhileStarting: true,
      };
    }
    if (!isAllowedHealthCheckUrl(healthUrl)) {
      return {
        status: 'unhealthy',
        message: 'Health check URL blocked by security policy',
        recordWhileStarting: true,
      };
    }

    let timeout: NodeJS.Timeout | undefined;
    try {
      timeout = setTimeout(
        () => controller.abort(new Error('Health check timeout')),
        this.options.httpTimeoutMs
      );
      timeout.unref?.();
      const response = await (isDynamicHealth ? this.fetchDynamicHealth : this.fetchHealth)(
        healthUrl,
        {
          method: 'GET',
          signal: controller.signal,
          // Do not follow redirects (see branches.ts): the distributed/managed
          // path is where a 302 to a link-local metadata endpoint matters most.
          redirect: 'manual',
        }
      );
      return {
        status: response.ok ? 'healthy' : 'unhealthy',
        message: response.ok
          ? `HTTP ${response.status}`
          : `HTTP ${response.status} ${response.statusText}`,
        recordWhileStarting: true,
      };
    } catch {
      if (this.shutdownRequested) return null;
      return {
        status: 'unhealthy',
        message: controller.signal.aborted ? 'Timeout' : 'Health endpoint unreachable',
        recordWhileStarting: false,
      };
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  async cleanup(): Promise<void> {
    if (this.shutdownRequested) return;
    const shutdownDeadline = Date.now() + this.options.shutdownDrainTimeoutMs;
    this.shutdownRequested = true;
    this.started = false;
    this.coordinationReady = false;
    this.rerunRequested = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const branches = this.app.service('branches');
    branches.off('created', this.onBranchHint);
    branches.off('patched', this.onBranchHint);
    branches.off('removed', this.onBranchHint);
    for (const { controller } of this.inFlight.values()) {
      controller.abort(new Error('Environment health monitor is shutting down'));
    }
    const drain = Promise.allSettled([
      ...(this.activeRun ? [this.activeRun] : []),
      ...[...this.inFlight.values()].map(({ work }) => work),
    ]).then(() => undefined);
    let drained = false;
    let timeout: NodeJS.Timeout | undefined;
    await Promise.race([
      drain.then(() => {
        drained = true;
      }),
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, Math.max(0, shutdownDeadline - Date.now()));
        timeout.unref?.();
      }),
    ]);
    if (timeout) clearTimeout(timeout);
    // If draining timed out, outbound work may still commit under its token;
    // leave those claims for expiry rather than releasing beneath live work.
    const releasableClaims = drained ? [...this.activeClaims.values()] : [];
    const releaseBudgetMs = Math.max(0, shutdownDeadline - Date.now());
    if (releaseBudgetMs > 0 && releasableClaims.length > 0) {
      const releaseWork = Promise.allSettled(
        releasableClaims.map(({ tenantId, claim }) =>
          runWithTenantContext(tenantId, () =>
            runWithTenantDatabaseScope(this.db, tenantId, (scopedDb) =>
              new EnvironmentHealthRepository(scopedDb).release(claim.branch_id, claim.claim_token)
            )
          )
        )
      );
      let releaseTimeout: NodeJS.Timeout | undefined;
      await Promise.race([
        releaseWork,
        new Promise<void>((resolve) => {
          releaseTimeout = setTimeout(resolve, releaseBudgetMs);
          releaseTimeout.unref?.();
        }),
      ]);
      if (releaseTimeout) clearTimeout(releaseTimeout);
    }
    for (const { tenantId, claim } of releasableClaims) {
      this.activeClaims.delete(this.claimKey(tenantId, claim.branch_id));
    }
    console.log(
      `[distributed-work.environment-health] event="loop_stopped" instance_id=${JSON.stringify(this.options.workIdentity.instanceId)} boot_id=${JSON.stringify(this.options.workIdentity.bootId)} drained=${drained} remaining_in_flight=${this.inFlight.size}`
    );
  }
}
