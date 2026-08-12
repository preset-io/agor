import {
  boundedBackoffDelay,
  type DistributedWorkIdentity,
  initialWorkOffset,
  jitterDelay,
} from '@agor/core/coordination';
import {
  type QueuedSessionCursor,
  type QueuedSessionRef,
  runWithSystemDatabaseScope,
  runWithTenantContext,
  runWithTenantDatabaseScope,
  TaskRepository,
  type TenantScopeAwareDatabase,
  type TenantScopedDatabase,
} from '@agor/core/db';
import type { AuthenticatedParams, SessionID, TenantID } from '@agor/core/types';

export interface SessionQueueWorkerOptions {
  tenantId?: TenantID | string;
  workIdentity: DistributedWorkIdentity;
  processSession: (sessionId: SessionID, params: AuthenticatedParams) => Promise<void>;
  scanBatchSize?: number;
  maxPagesPerSweep?: number;
  /** Delay between completed recovery sweeps. Ordinary queue draining is event-driven. */
  recoveryIntervalMs?: number;
  random?: () => number;
  /** Test seam; production discovery always uses the repository/RLS path. */
  discover?: (after?: QueuedSessionCursor) => Promise<QueuedSessionRef[]>;
}

/**
 * All-daemon recovery scanner for durable Session Task queues.
 *
 * It owns no lease and elects no leader. Every daemon may discover the same
 * bounded routing refs; the Session+Task repository claim elects the only
 * launcher. Cursor/backoff/jitter are contention etiquette and fairness only.
 */
export class SessionQueueWorker {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;
  private cursor: QueuedSessionCursor | undefined;
  private idleRounds = 0;
  private sweepComplete = false;
  private pagesInSweep = 0;
  private readonly scanBatchSize: number;
  private readonly maxPagesPerSweep: number;
  private readonly recoveryIntervalMs: number;
  private readonly random: () => number;

  constructor(
    private readonly db: TenantScopeAwareDatabase,
    private readonly options: SessionQueueWorkerOptions
  ) {
    this.scanBatchSize = options.scanBatchSize ?? 25;
    this.maxPagesPerSweep = options.maxPagesPerSweep ?? 10;
    this.recoveryIntervalMs = options.recoveryIntervalMs ?? 60_000;
    this.random = options.random ?? Math.random;
  }

  start(): void {
    if (this.timer || this.running) return;
    this.stopped = false;
    const initialDelayMs = initialWorkOffset(30_000, this.random());
    console.log(
      `[distributed-work.task-queue] event="loop_started" instance_id=${JSON.stringify(this.options.workIdentity.instanceId)} boot_id=${JSON.stringify(this.options.workIdentity.bootId)} scan_batch_size=${this.scanBatchSize} initial_delay_ms=${initialDelayMs}`
    );
    this.schedule(initialDelayMs);
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    console.log(
      `[distributed-work.task-queue] event="loop_stopped" instance_id=${JSON.stringify(this.options.workIdentity.instanceId)} boot_id=${JSON.stringify(this.options.workIdentity.bootId)}`
    );
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
    if (this.running || this.stopped) return;
    this.running = true;
    let found = 0;
    try {
      found = await this.checkOnce();
      this.idleRounds = 0;
    } catch (error) {
      this.idleRounds += 1;
      console.warn(
        `[distributed-work.task-queue] event=scan_failed instance_id=${JSON.stringify(this.options.workIdentity.instanceId)} boot_id=${JSON.stringify(this.options.workIdentity.bootId)} error=${JSON.stringify(error instanceof Error ? error.message : String(error))}`
      );
    } finally {
      this.running = false;
    }

    const delay = this.sweepComplete
      ? jitterDelay(this.recoveryIntervalMs, 0.1, this.random())
      : found >= this.scanBatchSize
        ? jitterDelay(150, 2 / 3, this.random())
        : boundedBackoffDelay(
            this.idleRounds,
            { baseDelayMs: 1_000, maxDelayMs: 30_000, jitterRatio: 0.2 },
            this.random()
          );
    this.schedule(delay);
  }

  private async discover(): Promise<QueuedSessionRef[]> {
    if (this.options.discover) return this.options.discover(this.cursor);
    const find = (scopedDb: TenantScopedDatabase) =>
      new TaskRepository(scopedDb).findQueuedSessionRefs(this.scanBatchSize, this.cursor);

    if (this.options.tenantId) {
      return runWithTenantDatabaseScope(this.db, this.options.tenantId, find);
    }
    return runWithSystemDatabaseScope(
      this.db,
      'Session Task queue discovery',
      (systemDb) =>
        new TaskRepository(systemDb).findQueuedSessionRefs(this.scanBatchSize, this.cursor),
      { capability: 'task_queue_discovery' }
    );
  }

  /** One bounded scan, exposed for deterministic tests and operational probes. */
  async checkOnce(): Promise<number> {
    this.sweepComplete = false;
    const refs = await this.discover();
    this.pagesInSweep += 1;
    if (refs.length === 0) {
      if (this.cursor) this.cursor = undefined;
      this.pagesInSweep = 0;
      this.sweepComplete = true;
      return 0;
    }
    const last = refs.at(-1)!;
    this.cursor = {
      session_id: last.session_id,
      ...(last.tenant_id ? { tenant_id: last.tenant_id } : {}),
    };

    for (const ref of refs) {
      const tenantId = this.options.tenantId ?? ref.tenant_id;
      if (!tenantId) {
        console.error(
          `[distributed-work.task-queue] event=route_missing_tenant session_id=${JSON.stringify(ref.session_id)}`
        );
        continue;
      }
      const params: AuthenticatedParams = {
        tenant: { tenant_id: tenantId as TenantID, source: 'explicit' },
      };
      try {
        await runWithTenantContext(tenantId, () =>
          this.options.processSession(ref.session_id, params)
        );
      } catch (error) {
        console.warn(
          `[distributed-work.task-queue] event=process_failed instance_id=${JSON.stringify(this.options.workIdentity.instanceId)} boot_id=${JSON.stringify(this.options.workIdentity.bootId)} tenant_id=${JSON.stringify(tenantId)} session_id=${JSON.stringify(ref.session_id)} error=${JSON.stringify(error instanceof Error ? error.message : String(error))}`
        );
      }
    }
    // A short keyset page is the end of this recovery sweep. Do not immediately
    // reconsider known-blocked queue heads: normal terminal/session patch hooks
    // wake them immediately, while the next sweep recovers missed events.
    if (refs.length < this.scanBatchSize) {
      this.cursor = undefined;
      this.pagesInSweep = 0;
      this.sweepComplete = true;
    } else if (this.pagesInSweep >= this.maxPagesPerSweep) {
      // Preserve the keyset cursor so the next bounded sweep resumes fairly.
      this.pagesInSweep = 0;
      this.sweepComplete = true;
    }
    return refs.length;
  }
}
