import type { ResolvedExecutorHeartbeatConfig } from '@agor/core/config';
import {
  boundedBackoffDelay,
  type DistributedWorkIdentity,
  initialWorkOffset,
  jitterDelay,
} from '@agor/core/coordination';
import {
  runWithSystemDatabaseScope,
  runWithTenantContext,
  runWithTenantDatabaseScope,
  TaskRepository,
  type TaskRuntimeDiscoveryCursor,
  type TaskRuntimeDiscoveryRef,
  type TenantScopeAwareDatabase,
} from '@agor/core/db';
import type { AuthenticatedParams, Task, TenantID } from '@agor/core/types';
import { TaskStatus } from '@agor/core/types';
import type { Application, TasksServiceImpl } from '../declarations.js';
import { getTrackedExecutor } from '../executor-tracking.js';
import { requestExecutorTermination } from '../termination-coordinator.js';
import { withFreshTenantWrite } from '../utils/tenant-db-scope.js';

export const EXECUTOR_HEARTBEAT_LOST_MESSAGE =
  'Executor heartbeat lost; the executor may have crashed or disconnected.';

type RuntimeCandidateKind = 'dispatch_timeout' | 'heartbeat_stale' | 'termination_stranded';

interface RuntimeCandidate extends TaskRuntimeDiscoveryRef {
  kind: RuntimeCandidateKind;
}

export interface TaskRuntimeReconcilerOptions {
  app: Application;
  db: TenantScopeAwareDatabase;
  config: ResolvedExecutorHeartbeatConfig;
  workIdentity: DistributedWorkIdentity;
  /** Static/single-tenant id. Undefined enables routing-only system discovery. */
  tenantId?: TenantID | string;
  dispatchConnectTimeoutMs?: number;
  scanBatchSize?: number;
  tickIntervalMs?: number;
  maxIdleIntervalMs?: number;
  startupOffsetMaxMs?: number;
  localOwnerGraceMs?: number;
  random?: () => number;
  /** Deterministic test clock. Production PostgreSQL discovery uses DB time when omitted. */
  now?: () => Date;
}

export interface TaskRuntimeReconcileStats {
  candidates: number;
  dispatchCandidates: number;
  heartbeatCandidates: number;
  terminationCandidates: number;
  processed: number;
  failures: number;
  saturated: boolean;
}

const DEFAULT_SCAN_BATCH_SIZE = 25;
const DEFAULT_MAX_IDLE_INTERVAL_MS = 60_000;
const DEFAULT_STARTUP_OFFSET_MAX_MS = 30_000;
const DEFAULT_LOCAL_OWNER_GRACE_MS = 15_000;
const SATURATED_DRAIN_BASE_MS = 150;
const SATURATED_DRAIN_JITTER_RATIO = 2 / 3; // 50..250ms

function tenantParams(tenantId: TenantID | string): AuthenticatedParams {
  return {
    provider: undefined,
    tenant: { tenant_id: tenantId as TenantID, source: 'explicit' },
  };
}

/**
 * Task-owned runtime recovery loop. PostgreSQL is authority; all daemons may
 * discover the same rows and repository transitions decide the winner.
 */
export class TaskRuntimeReconciler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = true;
  private idleRounds = 0;
  private readonly scanBatchSize: number;
  private readonly tickIntervalMs: number;
  private readonly random: () => number;
  private readonly discoveryCursors: Partial<
    Record<RuntimeCandidateKind, TaskRuntimeDiscoveryCursor>
  > = {};

  constructor(private readonly options: TaskRuntimeReconcilerOptions) {
    this.scanBatchSize = options.scanBatchSize ?? DEFAULT_SCAN_BATCH_SIZE;
    if (!Number.isInteger(this.scanBatchSize) || this.scanBatchSize <= 0) {
      throw new Error('Task runtime scan batch size must be a positive integer');
    }
    this.tickIntervalMs = options.tickIntervalMs ?? Math.min(options.config.interval_ms, 30_000);
    this.random = options.random ?? Math.random;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    const delay = initialWorkOffset(
      this.options.startupOffsetMaxMs ?? DEFAULT_STARTUP_OFFSET_MAX_MS,
      this.random()
    );
    this.schedule(delay);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.runLoopIteration();
    }, delayMs);
    this.timer.unref?.();
  }

  private async runLoopIteration(): Promise<void> {
    const stats = await this.checkOnce();
    if (this.stopped) return;
    let delay: number;
    if (stats.saturated) {
      this.idleRounds = 0;
      delay = jitterDelay(SATURATED_DRAIN_BASE_MS, SATURATED_DRAIN_JITTER_RATIO, this.random());
    } else if (stats.processed > 0 || stats.failures > 0) {
      this.idleRounds = 0;
      delay = jitterDelay(this.tickIntervalMs, 0.2, this.random());
    } else {
      delay = boundedBackoffDelay(
        this.idleRounds,
        {
          baseDelayMs: this.tickIntervalMs,
          maxDelayMs: this.options.maxIdleIntervalMs ?? DEFAULT_MAX_IDLE_INTERVAL_MS,
          jitterRatio: 0.2,
        },
        this.random()
      );
      this.idleRounds += 1;
    }
    this.schedule(delay);
  }

  private async discoverCandidates(): Promise<RuntimeCandidate[]> {
    const discover = async (tenantId?: TenantID | string) => {
      const repo = new TaskRepository(this.options.db);
      const now = this.options.now?.();
      const discoveryOptions = (kind: RuntimeCandidateKind) => ({
        limit: this.scanBatchSize,
        ...(this.discoveryCursors[kind] ? { after: this.discoveryCursors[kind] } : {}),
        ...(now ? { now } : {}),
      });
      const advanceCursor = (kind: RuntimeCandidateKind, refs: TaskRuntimeDiscoveryRef[]): void => {
        const last = refs.at(-1);
        if (last) this.discoveryCursors[kind] = last.cursor;
        else delete this.discoveryCursors[kind];
      };
      // Keep the routing transaction short and issue queries sequentially.
      // postgres.js does not permit concurrent queries on one transaction
      // connection, and these scans deliberately do not lock candidate rows.
      const dispatch = await repo.findExpiredDispatchRefs(
        this.options.dispatchConnectTimeoutMs ?? 5 * 60_000,
        discoveryOptions('dispatch_timeout')
      );
      advanceCursor('dispatch_timeout', dispatch);
      const heartbeat = this.options.config.enabled
        ? await repo.findStaleHeartbeatRefs(
            this.options.config.stale_after_ms,
            discoveryOptions('heartbeat_stale')
          )
        : [];
      advanceCursor('heartbeat_stale', heartbeat);
      const termination = await repo.findStrandedTerminationRefs(
        discoveryOptions('termination_stranded')
      );
      advanceCursor('termination_stranded', termination);
      const withTenant = (ref: TaskRuntimeDiscoveryRef): TaskRuntimeDiscoveryRef => ({
        ...ref,
        ...(tenantId ? { tenant_id: tenantId } : {}),
      });
      return [
        ...dispatch.map((ref) => ({ ...withTenant(ref), kind: 'dispatch_timeout' as const })),
        ...heartbeat.map((ref) => ({ ...withTenant(ref), kind: 'heartbeat_stale' as const })),
        ...termination.map((ref) => ({
          ...withTenant(ref),
          kind: 'termination_stranded' as const,
        })),
      ];
    };

    if (this.options.tenantId) {
      return runWithTenantDatabaseScope(this.options.db, this.options.tenantId, () =>
        discover(this.options.tenantId)
      );
    }
    return runWithSystemDatabaseScope(
      this.options.db,
      'task runtime reconciliation discovery',
      () => discover(),
      { capability: 'task_runtime_discovery' }
    );
  }

  private async processCandidate(candidate: RuntimeCandidate): Promise<boolean> {
    const tenantId = candidate.tenant_id ?? this.options.tenantId;
    if (!tenantId) throw new Error(`Task ${candidate.task_id} discovery omitted tenant routing`);
    return runWithTenantContext(tenantId, async () => {
      const params = tenantParams(tenantId);
      const tasks = this.options.app.service('tasks') as unknown as TasksServiceImpl;
      const task = await this.runInFreshTenantWriteDatabase(tenantId, () =>
        tasks.get(candidate.task_id, params)
      );
      switch (candidate.kind) {
        case 'dispatch_timeout':
          return this.reconcileDispatchTimeout(task, params);
        case 'heartbeat_stale':
          return this.reconcileStaleHeartbeat(task, candidate, params);
        case 'termination_stranded':
          return this.reconcileStrandedTermination(task, params);
      }
    });
  }

  private runInFreshTenantWriteDatabase<T>(
    tenantId: TenantID | string,
    work: () => Promise<T>
  ): Promise<T> {
    return withFreshTenantWrite(this.options.db, tenantId, work);
  }

  private async reconcileDispatchTimeout(
    task: Task,
    params: AuthenticatedParams
  ): Promise<boolean> {
    if (task.status !== TaskStatus.DISPATCHING || task.executor_connected_at) return false;
    if (task.executor_mode === 'templated') {
      const tasks = this.options.app.service('tasks') as unknown as TasksServiceImpl;
      const warned = await this.runInFreshTenantWriteDatabase(params.tenant!.tenant_id, () =>
        tasks.recordExecutorStartupWarning(
          task.task_id,
          'Remote executor has not connected within the configured startup window; still waiting.',
          params
        )
      );
      return !!warned;
    }
    const session = await this.runInFreshTenantWriteDatabase(params.tenant!.tenant_id, () =>
      this.options.app.service('sessions').get(task.session_id, params)
    );
    const result = await requestExecutorTermination({
      app: this.options.app,
      taskId: task.task_id,
      cause: 'startup_timeout',
      errorMessage: 'Local executor did not connect before the startup deadline.',
      params,
      expectedStatus: TaskStatus.DISPATCHING,
      requireExecutorDisconnected: true,
      sdkFailure: {
        reason: 'startup_timeout',
        detected_at: (this.options.now?.() ?? new Date()).toISOString(),
        tool: session.agentic_tool,
        termination: 'requested',
      },
      runInFreshTenantWriteDatabase: (work) =>
        this.runInFreshTenantWriteDatabase(params.tenant!.tenant_id, work),
    });
    return result.status !== 'condition_changed';
  }

  private async reconcileStaleHeartbeat(
    task: Task,
    candidate: RuntimeCandidate,
    params: AuthenticatedParams
  ): Promise<boolean> {
    if (
      !task.last_executor_heartbeat_at ||
      (task.status !== TaskStatus.RUNNING &&
        task.status !== TaskStatus.AWAITING_PERMISSION &&
        task.status !== TaskStatus.AWAITING_INPUT)
    ) {
      return false;
    }
    // Discovery is routing-only. If a fresh heartbeat won before the tenant
    // reload, do not turn that new fact into a new stale-termination claim.
    if (task.last_executor_heartbeat_at !== candidate.executor_heartbeat_at) return false;
    const session = await this.runInFreshTenantWriteDatabase(params.tenant!.tenant_id, () =>
      this.options.app.service('sessions').get(task.session_id, params)
    );
    const result = await requestExecutorTermination({
      app: this.options.app,
      taskId: task.task_id,
      cause: 'heartbeat_lost',
      errorMessage: EXECUTOR_HEARTBEAT_LOST_MESSAGE,
      params,
      expectedStatus: task.status,
      // Exact timestamp equality is the race fence. A heartbeat accepted after
      // discovery makes this claim lose even if daemon clocks disagree.
      expectedHeartbeatAt: task.last_executor_heartbeat_at,
      sdkFailure: {
        reason: 'heartbeat_lost',
        detected_at: (this.options.now?.() ?? new Date()).toISOString(),
        tool: session.agentic_tool,
        last_pulse: task.latest_executor_pulse,
        termination: 'requested',
      },
      runInFreshTenantWriteDatabase: (work) =>
        this.runInFreshTenantWriteDatabase(params.tenant!.tenant_id, work),
    });
    return result.status !== 'condition_changed';
  }

  private async reconcileStrandedTermination(
    task: Task,
    params: AuthenticatedParams
  ): Promise<boolean> {
    const request = task.termination_request;
    if (task.status !== TaskStatus.STOPPING || !request) return false;
    const ownsLocalHandle = !!getTrackedExecutor(task.session_id, this.options.app);
    const localMode = task.executor_mode !== 'templated';
    if (localMode && !ownsLocalHandle && task.sdk_failure?.termination === 'unverified') {
      return false;
    }
    const result = await requestExecutorTermination({
      app: this.options.app,
      taskId: task.task_id,
      cause: request.cause,
      errorMessage: request.error_message ?? 'Resuming durable executor termination.',
      params,
      allowUnownedLocalContainment: localMode && !ownsLocalHandle,
      ...(localMode && !ownsLocalHandle
        ? {
            unownedLocalOwnerGraceMs:
              this.options.localOwnerGraceMs ?? DEFAULT_LOCAL_OWNER_GRACE_MS,
          }
        : {}),
      sdkFailure: task.sdk_failure,
      runInFreshTenantWriteDatabase: (work) =>
        this.runInFreshTenantWriteDatabase(params.tenant!.tenant_id, work),
    });
    return result.status !== 'condition_changed';
  }

  async checkOnce(): Promise<TaskRuntimeReconcileStats> {
    if (this.running) {
      return {
        candidates: 0,
        dispatchCandidates: 0,
        heartbeatCandidates: 0,
        terminationCandidates: 0,
        processed: 0,
        failures: 0,
        saturated: false,
      };
    }
    this.running = true;
    const stats: TaskRuntimeReconcileStats = {
      candidates: 0,
      dispatchCandidates: 0,
      heartbeatCandidates: 0,
      terminationCandidates: 0,
      processed: 0,
      failures: 0,
      saturated: false,
    };
    try {
      const candidates = await this.discoverCandidates();
      stats.candidates = candidates.length;
      stats.dispatchCandidates = candidates.filter((c) => c.kind === 'dispatch_timeout').length;
      stats.heartbeatCandidates = candidates.filter((c) => c.kind === 'heartbeat_stale').length;
      stats.terminationCandidates = candidates.filter(
        (c) => c.kind === 'termination_stranded'
      ).length;
      stats.saturated =
        stats.dispatchCandidates >= this.scanBatchSize ||
        stats.heartbeatCandidates >= this.scanBatchSize ||
        stats.terminationCandidates >= this.scanBatchSize;

      for (const candidate of candidates) {
        try {
          if (await this.processCandidate(candidate)) stats.processed += 1;
        } catch (error) {
          stats.failures += 1;
          console.warn(
            `[distributed-work.task-runtime] event=candidate_failed` +
              ` instance_id=${JSON.stringify(this.options.workIdentity.instanceId)}` +
              ` boot_id=${JSON.stringify(this.options.workIdentity.bootId)}` +
              ` tenant_id=${JSON.stringify(candidate.tenant_id ?? this.options.tenantId)}` +
              ` task_id=${JSON.stringify(candidate.task_id)}` +
              ` kind=${candidate.kind}` +
              ` error=${JSON.stringify(error instanceof Error ? error.name : 'unknown')}`
          );
        }
      }
      if (stats.candidates > 0 || stats.failures > 0) {
        console.info(
          `[distributed-work.task-runtime] event=scan_complete` +
            ` instance_id=${JSON.stringify(this.options.workIdentity.instanceId)}` +
            ` boot_id=${JSON.stringify(this.options.workIdentity.bootId)}` +
            ` candidates=${stats.candidates}` +
            ` processed=${stats.processed}` +
            ` failures=${stats.failures}` +
            ` saturated=${stats.saturated}`
        );
      }
      return stats;
    } catch (error) {
      console.warn(
        `[distributed-work.task-runtime] event=scan_failed instance_id=${JSON.stringify(this.options.workIdentity.instanceId)} boot_id=${JSON.stringify(this.options.workIdentity.bootId)} error=${JSON.stringify(error instanceof Error ? error.name : 'unknown')}`
      );
      stats.failures += 1;
      return stats;
    } finally {
      this.running = false;
    }
  }
}
