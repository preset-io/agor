import type { ResolvedExecutorHeartbeatConfig } from '@agor/core/config';
import {
  type ActiveExecutorAttemptRef,
  runWithSystemDatabaseScope,
  runWithTenantContext,
  runWithTenantDatabaseScope,
  shortId,
  TaskRepository,
  type TenantScopeAwareDatabase,
} from '@agor/core/db';
import type { Params, Task, TenantContext, TenantID } from '@agor/core/types';
import {
  EXECUTOR_FINALIZABLE_TASK_STATUSES,
  EXECUTOR_TERMINAL_CAUSE,
  TaskStatus,
} from '@agor/core/types';
import type { Application, TasksServiceImpl } from '../declarations.js';
import { ExecutorAttemptCoordinator } from './executor-attempt-coordinator.js';

export const EXECUTOR_HEARTBEAT_LOST_MESSAGE =
  'Executor heartbeat lost; the executor may have crashed or disconnected.';
export const EXECUTOR_DISPATCH_TIMEOUT_MESSAGE =
  'Executor did not connect before the dispatch deadline.';

export interface ExecutorAttemptReconcilerOptions {
  app: Application;
  config: ResolvedExecutorHeartbeatConfig;
  db?: TenantScopeAwareDatabase;
  tenantId?: TenantID | string;
  requireTenantParams?: boolean;
  tickIntervalMs?: number;
  now?: () => Date;
  coordinator?: Pick<ExecutorAttemptCoordinator, 'reconcile'>;
  discoverActiveAttemptRefs?: () => Promise<ActiveExecutorAttemptRef[]>;
}

type ExecutorReconcileParams = Params & { tenant?: TenantContext };

/** Reconciles dispatch, heartbeat, cleanup, and readiness for executor-owned turns. */
export class ExecutorAttemptReconciler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private options: ExecutorAttemptReconcilerOptions) {
    options.tickIntervalMs ??= Math.min(options.config.interval_ms, 30_000);
    options.now ??= () => new Date();
    options.coordinator ??= new ExecutorAttemptCoordinator(options.app, { db: options.db });
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.checkOnce(), this.options.tickIntervalMs!);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async checkOnce(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (const ref of await this.findActiveAttemptRefs()) {
        await this.reconcileRef(ref);
      }
    } catch (error) {
      console.warn(
        '[executor-attempt] Reconciler check failed:',
        error instanceof Error ? error.message : String(error)
      );
    } finally {
      this.running = false;
    }
  }

  private async findActiveAttemptRefs(): Promise<ActiveExecutorAttemptRef[]> {
    const find =
      this.options.discoverActiveAttemptRefs ??
      (() => {
        if (!this.options.db) {
          throw new Error('Executor-attempt discovery requires a database or discovery function');
        }
        return new TaskRepository(this.options.db).findActiveExecutorAttemptRefs();
      });

    if (this.options.tenantId && this.options.db) {
      return runWithTenantDatabaseScope(this.options.db, this.options.tenantId, find);
    }
    if (!this.options.db) return find();
    return runWithSystemDatabaseScope(
      this.options.db,
      'executor attempt reconciliation discovery',
      find
    );
  }

  private async reconcileRef(ref: ActiveExecutorAttemptRef): Promise<void> {
    const tenantId = this.options.tenantId ?? ref.tenant_id;
    if (!tenantId && this.options.requireTenantParams) {
      console.error(
        `[executor-attempt] Skipping task ${shortId(ref.task_id)}: missing tenant metadata`
      );
      return;
    }

    const params: ExecutorReconcileParams | undefined = tenantId
      ? {
          tenant: {
            tenant_id: tenantId as TenantID,
            source: this.options.tenantId ? 'static' : 'explicit',
          },
        }
      : undefined;
    const work = () => this.reconcileTask(ref.task_id, params);

    try {
      await (tenantId
        ? runWithTenantContext(tenantId, () =>
            this.options.db ? runWithTenantDatabaseScope(this.options.db, tenantId, work) : work()
          )
        : work());
    } catch (error) {
      console.warn(
        `[executor-attempt] Failed to reconcile task ${shortId(ref.task_id)}:`,
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  private async reconcileTask(taskId: string, params?: Params): Promise<void> {
    const tasksService = this.options.app.service('tasks') as unknown as TasksServiceImpl;
    const task = (await tasksService.get(taskId, params)) as Task;
    const executorAttemptId = task.executor_attempt_id;
    if (!executorAttemptId) return;

    if (EXECUTOR_FINALIZABLE_TASK_STATUSES.has(task.status)) {
      await this.options.coordinator!.reconcile({
        taskId: task.task_id,
        executorAttemptId,
        params,
      });
      return;
    }

    const lease = this.expiredLease(task);
    if (!lease) return;
    const failure = await tasksService.failExpiredExecutorAttempt(
      task.task_id,
      {
        executor_attempt_id: executorAttemptId,
        stale_before: lease.staleBefore,
        completed_at: this.options.now!().toISOString(),
        error_message: lease.message,
        terminal_cause: lease.cause,
      },
      params
    );
    if (!failure.transitioned) return;
    const settlement = await this.options.coordinator!.reconcile({
      taskId: failure.task.task_id,
      executorAttemptId,
      params,
    });
    console.warn(
      `[executor-attempt] Marked task ${shortId(failure.task.task_id)} failed ` +
        `(${lease.cause}, released=${settlement.released})`
    );
  }

  private expiredLease(task: Task) {
    const nowMs = this.options.now!().getTime();
    const dispatching = task.status === TaskStatus.DISPATCHING;
    if (!dispatching && !this.options.config.enabled) return undefined;

    const timeoutMs = dispatching
      ? this.options.config.connection_timeout_ms
      : this.options.config.stale_after_ms;
    const leaseAt = Date.parse(
      dispatching
        ? (task.started_at ?? '')
        : (task.last_executor_heartbeat_at ?? task.executor_connected_at ?? '')
    );
    if (!Number.isFinite(leaseAt) || nowMs - leaseAt <= timeoutMs) return undefined;

    return {
      cause: dispatching
        ? EXECUTOR_TERMINAL_CAUSE.DISPATCH_TIMEOUT
        : EXECUTOR_TERMINAL_CAUSE.HEARTBEAT_LOST,
      staleBefore: new Date(nowMs - timeoutMs).toISOString(),
      message: dispatching ? EXECUTOR_DISPATCH_TIMEOUT_MESSAGE : EXECUTOR_HEARTBEAT_LOST_MESSAGE,
    };
  }
}
