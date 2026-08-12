/**
 * Startup & Shutdown
 *
 * Orchestrates post-boot steps: orphan cleanup, health monitor, server listen,
 * scheduler, gateway init, and graceful shutdown.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  type AgorConfig,
  getAgorHome,
  type ResolvedEnvironmentHealthMonitorSettings,
  resolveDeploymentAgenticToolPolicy,
  resolveDispatchConnectTimeoutMs,
  resolveExecutorHeartbeatConfig,
  resolveMultiTenancyConfig,
} from '@agor/core/config';
import type { DistributedWorkIdentity } from '@agor/core/coordination';
import {
  MessagesRepository,
  RuntimeRecoveryDiscoveryRepository,
  runWithSystemDatabaseScope,
  runWithTenantContext,
  runWithTenantDatabaseScope,
  SessionRepository,
  shortId,
  type TenantScopeAwareDatabase,
} from '@agor/core/db';
import type { Id, Paginated, Session, SessionID, Task, TenantContext } from '@agor/core/types';
import { isTerminalTaskStatus, SessionStatus } from '@agor/core/types';
import type { Application, SessionsServiceImpl, TasksServiceImpl } from './declarations.js';
import { containAllTrackedExecutors, restoreExecutorProcess } from './executor-tracking.js';
import { DistributedHealthMonitor } from './services/distributed-health-monitor.js';
import type { GatewayService } from './services/gateway.js';
import { HealthMonitor } from './services/health-monitor.js';
import { KnowledgeEmbeddingIndexer } from './services/knowledge-embedding-indexer.js';
import {
  MCPCatalogIngestionWorker,
  resolveMCPCatalogOptions,
} from './services/mcp-catalog-ingestion.js';
import { SchedulerService } from './services/scheduler.js';
import { SessionQueueWorker } from './services/session-queue-worker.js';
import {
  TaskRuntimeReconciler,
  type TaskRuntimeReconcilerStartOptions,
} from './services/task-runtime-reconciler.js';
import type { TerminalsService } from './services/terminals.js';
import { claimExecutorTermination, requestExecutorTermination } from './termination-coordinator.js';
import { appendSystemMessage } from './utils/append-system-message.js';
import { scrubManagedGitRemoteCredentials } from './utils/git-remote-credential-scan.js';
import {
  generateScopedServiceToken,
  getDaemonUrl,
  runExecutorCommand,
} from './utils/spawn-executor.js';
import { formatStructuredLog, structuredLogErrorCode } from './utils/structured-log.js';

const DEBUG_STARTUP =
  process.env.AGOR_DEBUG_STARTUP === '1' || process.env.DEBUG?.includes('startup');

function startupDebug(...args: unknown[]): void {
  if (DEBUG_STARTUP) {
    console.debug(...args);
  }
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

export interface StartupContext {
  app: Application;
  db: TenantScopeAwareDatabase;
  config: AgorConfig;
  DAEMON_PORT: number;
  /** Bind address (default: 'localhost', use '0.0.0.0' for containers) */
  DAEMON_HOST: string;
  /** Safe service getter — returns undefined if service is not registered */
  // biome-ignore lint/suspicious/noExplicitAny: FeathersJS service return type varies by path
  safeService: (path: string) => any;
  /** Socket.io getSocketServer accessor for graceful shutdown */
  getSocketServer: () => import('socket.io').Server | null;
  /** Services returned from registerServices() */
  sessionsService: SessionsServiceImpl;
  terminalsService: TerminalsService | null;
  /** One diagnostic identity owned by this daemon application/process. */
  distributedWorkIdentity: DistributedWorkIdentity;
  /** Releases the process-local direct-launch fence after ordered standalone recovery. */
  releaseTaskAdmission?: () => void;
  /**
   * Explicit activation boundary while daemon HA configuration is still
   * landing. `standalone` preserves historical active-runtime boot repair
   * while retaining durable queues; `shared_postgres` treats all durable Task
   * state as replica-independent.
   */
  taskRuntimePolicy: TaskRuntimePolicy;
  /** Required Redis/Socket.IO lifecycle in explicit HA mode. */
  realtimeRuntime?: Pick<
    import('./realtime/redis-realtime.js').RedisRealtimeRuntime,
    'beginDrain' | 'close'
  >;
  /** Environment observation ownership policy; aligned with Task runtime naming. */
  environmentHealthMonitorPolicy: EnvironmentHealthMonitorPolicy;
  /** Required worker tuning resolved and validated by the HA deployment config. */
  environmentHealthMonitorSettings?: ResolvedEnvironmentHealthMonitorSettings;
}

export type TaskRuntimePolicy = 'standalone' | 'shared_postgres';
export type EnvironmentHealthMonitorPolicy = 'standalone' | 'shared_postgres';

type EnvironmentHealthMonitor = {
  initialize: () => Promise<void> | void;
  cleanup: () => Promise<void> | void;
  isReady?: () => boolean;
};
type EnvironmentHealthMonitorFactory = (
  policy: EnvironmentHealthMonitorPolicy,
  app: Application,
  ctx: StartupContext
) => EnvironmentHealthMonitor;

/**
 * Standalone shutdown preserves the historical containment contract. Shared
 * replicas must not intentionally contain detached executors: killing them and
 * then losing the process-local evidence would force another replica to claim
 * uncertainty. Actual survival still depends on the execution substrate.
 */
export function shouldContainLocalExecutorsOnShutdown(policy: TaskRuntimePolicy): boolean {
  return policy === 'standalone';
}

/** Preserve standalone's terminal Socket.IO disconnect while HA invites failover reconnect. */
export function shouldReconnectSocketClientsOnShutdown(policy: TaskRuntimePolicy): boolean {
  return policy === 'shared_postgres';
}

/**
 * Construction boundary for standalone timers versus PostgreSQL-coordinated
 * all-daemon observation. A mismatched Task/environment policy fails closed.
 */
export function createEnvironmentHealthMonitor(
  ctx: StartupContext,
  factory: EnvironmentHealthMonitorFactory = (policy, app, startupCtx) => {
    if (policy === 'standalone') {
      const multiTenancy = resolveMultiTenancyConfig(startupCtx.config);
      return new HealthMonitor(app, {
        defaultParams: startupTenantParams(startupCtx.config),
        db: startupCtx.db,
        tenantId: multiTenancy.mode === 'static' ? multiTenancy.static_tenant_id : undefined,
        requireTenantParams: multiTenancy.mode !== 'static',
      });
    }
    if (!startupCtx.environmentHealthMonitorSettings) {
      throw new Error('Distributed environment health monitor settings are required');
    }
    return new DistributedHealthMonitor(app, startupCtx.db, {
      workIdentity: startupCtx.distributedWorkIdentity,
      ...startupCtx.environmentHealthMonitorSettings,
    });
  }
): EnvironmentHealthMonitor | null {
  if (ctx.taskRuntimePolicy !== ctx.environmentHealthMonitorPolicy) {
    return null;
  }
  return factory(ctx.environmentHealthMonitorPolicy, ctx.app, ctx);
}

// ---------------------------------------------------------------------------
// Sentinel file — distinguishes graceful shutdown from crashes
// ---------------------------------------------------------------------------

const SENTINEL_FILENAME = 'daemon-shutdown-clean.flag';
const SENTINEL_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24h — stale sentinels are treated as crashes

interface ShutdownSentinel {
  timestamp: string;
  signal: string;
}

async function writeCleanShutdownSentinel(signal: string): Promise<void> {
  try {
    const sentinel: ShutdownSentinel = { timestamp: new Date().toISOString(), signal };
    await fs.writeFile(
      path.join(getAgorHome(), SENTINEL_FILENAME),
      JSON.stringify(sentinel),
      'utf8'
    );
  } catch (error) {
    // Non-fatal — worst case, startup treats the next restart as unexpected
    // and triggers orphan cleanup, which is the safer default. We surface
    // a single warning so operators debugging crash-classification in
    // read-only AGOR_HOME deployments (e.g. ConfigMap-mounted) can see
    // why the sentinel isn't doing anything.
    console.warn(
      '[startup] Could not write shutdown sentinel — next restart will be classified as a crash. ' +
        `Cause: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/** Read and immediately delete the sentinel. Returns whether shutdown was graceful. */
async function readAndClearSentinel(): Promise<boolean> {
  const sentinelPath = path.join(getAgorHome(), SENTINEL_FILENAME);
  try {
    const raw = await fs.readFile(sentinelPath, 'utf8');
    await fs.unlink(sentinelPath);
    const sentinel = JSON.parse(raw) as ShutdownSentinel;
    const age = Date.now() - new Date(sentinel.timestamp).getTime();
    return age < SENTINEL_MAX_AGE_MS;
  } catch {
    // Missing file = crash, stale/corrupt = treat as crash
    return false;
  }
}

// ---------------------------------------------------------------------------
// Orphan cleanup
// ---------------------------------------------------------------------------

function startupTenantParams(config: AgorConfig, tenantId?: string): { tenant: TenantContext } {
  const resolved = tenantId ?? resolveMultiTenancyConfig(config).static_tenant_id;
  return {
    tenant: {
      tenant_id: resolved as TenantContext['tenant_id'],
      source: tenantId ? 'explicit' : 'static',
    },
  };
}

async function runStartupTenantDatabaseScope<T>(
  ctx: Pick<StartupContext, 'config' | 'db'>,
  work: () => Promise<T>,
  tenantId?: string
): Promise<T> {
  const id = startupTenantParams(ctx.config, tenantId).tenant.tenant_id;
  return runWithTenantDatabaseScope(ctx.db, id, work);
}

interface TenantRuntimeRecovery {
  tenantId: string;
  orphanedTasks: Task[];
  orphanedSessions: Session[];
  sessionsResetFromOrphanedTasks: number;
  stuckIdleSessions: Session[];
}

interface OrphanCleanupResult {
  wasGraceful: boolean;
  recoveries: TenantRuntimeRecovery[];
  orphanedTasks: Task[];
  orphanedSessions: Session[];
  sessionIdsWithOrphanedTasks: Set<string>;
  sessionsResetFromOrphanedTasks: number;
}

async function collectAllPages<T>(
  fetchPage: (skip: number) => Promise<T[] | Paginated<T>>
): Promise<T[]> {
  const rows: T[] = [];
  while (true) {
    const result = await fetchPage(rows.length);
    const page = Array.isArray(result) ? result : result.data;
    rows.push(...page);
    const total = Array.isArray(result) ? rows.length : result.total;
    if (page.length === 0 || rows.length >= total) return rows;
  }
}

async function startupTenantIds(ctx: StartupContext): Promise<string[]> {
  const config = resolveMultiTenancyConfig(ctx.config);
  if (config.mode === 'static') return [config.static_tenant_id];
  return runWithSystemDatabaseScope(
    ctx.db,
    'task runtime recovery discovery',
    (db) => new RuntimeRecoveryDiscoveryRepository(db).findRecoveryTenantIds(),
    { capability: 'task_runtime_recovery' }
  );
}

async function recoverTenantRuntime(
  ctx: StartupContext,
  tenantId: string
): Promise<TenantRuntimeRecovery> {
  const tasks = ctx.app.service('tasks') as unknown as TasksServiceImpl;
  const sessions = ctx.sessionsService;
  const params = startupTenantParams(ctx.config, tenantId);
  const inDatabaseScope = <T>(work: () => Promise<T>) =>
    runStartupTenantDatabaseScope(ctx, work, tenantId);
  const orphanedTasks = await inDatabaseScope(() => tasks.getOrphaned(params as never));

  for (const task of orphanedTasks) {
    const runtime = task.metadata?.executor_runtime;
    if (runtime) restoreExecutorProcess(task.session_id, task.task_id, runtime, ctx.app);
    await inDatabaseScope(() =>
      claimExecutorTermination({
        app: ctx.app,
        taskId: task.task_id,
        cause: 'daemon_restart',
        errorMessage: 'Daemon restart requires executor containment before this Task can settle.',
        params: params as never,
      })
    );
  }

  // QUEUED Tasks are durable user intent. Leave them intact for the fleet-wide
  // queue worker; runtime recovery only reconciles active Task/Session truth.
  const orphanedSessions: Session[] = [];
  for (const status of [
    SessionStatus.RUNNING,
    SessionStatus.STOPPING,
    SessionStatus.AWAITING_PERMISSION,
    SessionStatus.AWAITING_INPUT,
  ]) {
    orphanedSessions.push(
      ...(await collectAllPages<Session>((skip) =>
        inDatabaseScope(
          () =>
            sessions.find({
              query: { status, $limit: 1000, $skip: skip },
              ...params,
            }) as Promise<Session[] | Paginated<Session>>
        )
      ))
    );
  }

  for (const session of orphanedSessions) {
    await inDatabaseScope(() =>
      tasks.reconcileSessionState(session.session_id, {
        ...params,
        suppressTerminalQueueProcessing: true,
      } as never)
    );
    startupDebug(
      `   ✓ Reconciled session ${shortId(session.session_id)} from Task truth (was: ${session.status})`
    );
  }

  const sessionIdsWithOrphanedTasks = new Set(orphanedTasks.map((task) => String(task.session_id)));
  let sessionsResetFromOrphanedTasks = 0;
  for (const sessionId of sessionIdsWithOrphanedTasks) {
    const session = await inDatabaseScope(() => sessions.get(sessionId as Id, params as never));
    if (
      session.status === SessionStatus.RUNNING ||
      session.status === SessionStatus.STOPPING ||
      session.status === SessionStatus.AWAITING_PERMISSION ||
      session.status === SessionStatus.TIMED_OUT
    ) {
      await inDatabaseScope(() =>
        tasks.reconcileSessionState(sessionId, {
          ...params,
          suppressTerminalQueueProcessing: true,
        } as never)
      );
      sessionsResetFromOrphanedTasks += 1;
    }
  }

  // IDLE + ready=false is normally a read/attention state. Repair only rows
  // whose latest Task was active at boot or remains nonterminal.
  const bootInterruptedTaskIds = new Set(orphanedTasks.map((task) => String(task.task_id)));
  const idleNotReadySessions = await collectAllPages<Session>((skip) =>
    inDatabaseScope(
      () =>
        sessions.find({
          query: {
            status: SessionStatus.IDLE,
            ready_for_prompt: false,
            $limit: 1000,
            $skip: skip,
          },
          ...params,
        }) as Promise<Session[] | Paginated<Session>>
    )
  );
  const stuckIdleSessions: Session[] = [];
  for (const session of idleNotReadySessions) {
    const latestTaskId = session.tasks?.at(-1);
    if (!latestTaskId) continue;

    let wasInterrupted = bootInterruptedTaskIds.has(String(latestTaskId));
    if (!wasInterrupted) {
      try {
        const latestTask = await inDatabaseScope(() => tasks.get(latestTaskId, params as never));
        wasInterrupted = !isTerminalTaskStatus(latestTask.status);
      } catch {
        // Missing or invisible Task truth fails closed.
      }
    }
    if (!wasInterrupted) continue;

    stuckIdleSessions.push(session);
    await inDatabaseScope(() =>
      tasks.reconcileSessionState(session.session_id, {
        ...params,
        suppressTerminalQueueProcessing: true,
      } as never)
    );
  }

  return {
    tenantId,
    orphanedTasks,
    orphanedSessions,
    sessionsResetFromOrphanedTasks,
    stuckIdleSessions,
  };
}

export async function cleanupOrphanStatuses(ctx: StartupContext): Promise<OrphanCleanupResult> {
  const wasGraceful = await readAndClearSentinel();
  const recoveries: TenantRuntimeRecovery[] = [];
  for (const tenantId of await startupTenantIds(ctx)) {
    recoveries.push(
      await runWithTenantContext(tenantId, () => recoverTenantRuntime(ctx, tenantId))
    );
  }

  const orphanedTasks = recoveries.flatMap((recovery) => recovery.orphanedTasks);
  const orphanedSessions = recoveries.flatMap((recovery) => recovery.orphanedSessions);
  const sessionIdsWithOrphanedTasks = new Set(orphanedTasks.map((task) => String(task.session_id)));
  const sessionsResetFromOrphanedTasks = recoveries.reduce(
    (total, recovery) => total + recovery.sessionsResetFromOrphanedTasks,
    0
  );
  const stuckIdleSessions = recoveries.flatMap((recovery) => recovery.stuckIdleSessions);
  const cleanupParts = [
    `${orphanedTasks.length} orphaned task(s) claimed for containment`,
    `${orphanedSessions.length} active session(s) reconciled`,
    'durable queued task(s) preserved',
  ];
  if (sessionsResetFromOrphanedTasks > 0) {
    cleanupParts.push(`${sessionsResetFromOrphanedTasks} task-owned session(s) reconciled`);
  }
  if (stuckIdleSessions.length > 0) {
    cleanupParts.push(`${stuckIdleSessions.length} stuck-idle session(s) unblocked`);
  }
  console.log(`[startup] runtime recovery: ${cleanupParts.join(', ')}`);

  return {
    wasGraceful,
    recoveries,
    orphanedTasks,
    orphanedSessions,
    sessionIdsWithOrphanedTasks,
    sessionsResetFromOrphanedTasks,
  };
}

export async function resumeRuntimeRecovery(
  ctx: StartupContext,
  cleanup: OrphanCleanupResult
): Promise<void> {
  for (const recovery of cleanup.recoveries) {
    const params = startupTenantParams(ctx.config, recovery.tenantId);
    await runWithTenantContext(recovery.tenantId, async () => {
      for (const task of recovery.orphanedTasks) {
        try {
          await requestExecutorTermination({
            app: ctx.app,
            taskId: task.task_id,
            cause: 'daemon_restart',
            errorMessage:
              'Daemon restart requires executor containment before this Task can settle.',
            params: { ...params, suppressTerminalQueueProcessing: true } as never,
            withTenantDatabase: (work) =>
              runStartupTenantDatabaseScope(ctx, work, recovery.tenantId),
          });
        } catch (error) {
          console.warn(
            formatStructuredLog('[startup.runtime_recovery]', {
              operation: 'resume_containment',
              outcome: 'failed',
              task_id: shortId(task.task_id),
              error_code: structuredLogErrorCode(error),
            })
          );
        }
      }

      try {
        await injectRestartNotices(ctx, cleanup.wasGraceful, recovery);
      } catch (error) {
        console.warn(
          formatStructuredLog('[startup.runtime_recovery]', {
            operation: 'record_restart_notices',
            outcome: 'failed',
            tenant_id: recovery.tenantId,
            error_code: structuredLogErrorCode(error),
          })
        );
      }
    });
  }
}

async function injectRestartNotices(
  ctx: StartupContext,
  wasGraceful: boolean,
  recovery: TenantRuntimeRecovery
): Promise<void> {
  const { app, db, sessionsService } = ctx;
  const { tenantId, orphanedTasks, orphanedSessions } = recovery;

  // Get tasks service from the app (registered during services phase)
  const tasksService = app.service('tasks') as unknown as TasksServiceImpl;
  const startupParams = startupTenantParams(ctx.config, tenantId);

  // Inject a system message into every affected session so the user (and the
  // agent on resume) see an in-transcript explanation — not a toast, a
  // persistent record in the conversation. Contrast with PR #1116 (filtered
  // high-frequency SDK lifecycle noise): this is intentional, low-frequency,
  // and user-meaningful.
  //
  // The message MUST be attached to a task: the reactive client drops taskless
  // messages (ReactiveSessionState groups messages by task_id), so a notice
  // with no task_id would be silently invisible in the UI.
  const affectedSessionIds = new Set<string>([
    ...orphanedSessions.map((s) => s.session_id as string),
    ...orphanedTasks.map((task) => String(task.session_id)),
  ]);

  if (affectedSessionIds.size === 0) {
    return;
  }

  console.log(`🧹 Injecting daemon restart notices for ${affectedSessionIds.size} session(s)...`);

  const restartType = wasGraceful ? ('daemon_restart' as const) : ('daemon_crash' as const);
  const messageText = wasGraceful
    ? 'The Agor daemon was restarted while this session was running.'
    : 'The Agor daemon restarted unexpectedly while this session was running.';

  // Build session → last orphaned task map so we can attach notices to a task_id.
  // Prefer orphaned tasks (they were the active tasks at shutdown); fall back to
  // querying the session's most-recent task if none was orphaned.
  const lastOrphanedTaskBySession = new Map<string, Task>();
  for (const task of orphanedTasks) {
    const sid = task.session_id as string;
    const existing = lastOrphanedTaskBySession.get(sid);
    if (!existing || task.created_at > existing.created_at) {
      lastOrphanedTaskBySession.set(sid, task);
    }
  }

  const sessionRepo = new SessionRepository(db);
  const messageRepo = new MessagesRepository(db);

  for (const sessionId of affectedSessionIds) {
    try {
      await runStartupTenantDatabaseScope(
        ctx,
        async () => {
          // Resolve the task to attach the notice to
          let attachTask = lastOrphanedTaskBySession.get(sessionId);
          if (!attachTask) {
            // Sessions maintain an ordered task-ID list; the last entry is the most
            // recent task without relying on TasksService.find() sort behavior.
            const session = await sessionsService.get(sessionId as Id, startupParams as never);
            const latestTaskId = session.tasks?.at(-1);
            if (latestTaskId) {
              attachTask = await tasksService.get(latestTaskId, startupParams as never);
            }
          }
          if (!attachTask) {
            // No task exists — message would be invisible (transcript is task-scoped).
            // This session has never had any work, so there is nothing for the user to resume.
            console.log(
              `   ⏭  Session ${shortId(sessionId)} has no tasks — skipping restart notice`
            );
            return;
          }

          // Idempotency: skip if the last message is already a daemon restart notice
          // (guards against rapid restart cycles piling up notices before the user responds)
          const messageCount = await sessionRepo.countMessages(sessionId);
          if (messageCount > 0) {
            const lastMessages = await messageRepo.findByRange(
              sessionId as SessionID,
              messageCount - 1,
              messageCount - 1
            );
            const last = lastMessages[0];
            if (last?.type === 'daemon_restart' || last?.type === 'daemon_crash') {
              console.log(
                `   ⏭  Session ${shortId(sessionId)} already has a restart notice — skipping`
              );
              return;
            }
          }

          const injectedMessage = await appendSystemMessage({
            app,
            db,
            sessionId,
            taskId: attachTask.task_id,
            type: restartType,
            content: messageText,
            metadata: { source: 'agor' },
          });

          // Extend the task's message_range.end_index so the notice is counted
          // and loaded within the task's window in the UI.
          // Pass only end_index: TaskRepository.update() deep-merges with the live
          // DB row, preserving fields written by the STOPPED patch (e.g. end_timestamp).
          if (attachTask.message_range) {
            await tasksService.patch(attachTask.task_id, {
              message_range: { end_index: injectedMessage.index } as Task['message_range'],
            });
          }

          console.log(`   ✉  Injected ${restartType} notice into session ${shortId(sessionId)}`);
        },
        tenantId
      );
    } catch (err) {
      console.warn(
        `   ⚠️  Failed to inject restart notice into session ${shortId(sessionId)}:`,
        err
      );
    }
  }
}

export function runPostStartJob(name: string, job: () => Promise<void> | void): void {
  void Promise.resolve()
    .then(() => job())
    .then(() => {
      startupDebug(`[startup] post-start job completed: ${name}`);
    })
    .catch((error: unknown) => {
      console.warn(`[startup] post-start job failed: ${name}`, error);
    });
}

export async function startTaskWorkersAfterRecovery(input: {
  recover: () => Promise<void>;
  reconciler: {
    checkOnce: TaskRuntimeReconciler['checkOnce'];
    start: (options?: TaskRuntimeReconcilerStartOptions) => void;
  };
  startQueueWorker: () => void;
  releaseTaskAdmission: () => void;
}): Promise<void> {
  const startAdmissionWorkers = () => {
    input.startQueueWorker();
    input.releaseTaskAdmission();
  };
  await input.recover();
  let scanComplete = false;
  let preserveDiscoveryCursors = false;
  try {
    const stats = await input.reconciler.checkOnce({ suppressTerminalQueueProcessing: true });
    scanComplete = stats.failures === 0 && !stats.saturated;
    preserveDiscoveryCursors = stats.failures === 0 && stats.saturated;
  } catch (error) {
    console.warn(
      formatStructuredLog('[startup.runtime_recovery]', {
        operation: 'immediate_scan',
        outcome: 'failed',
        error_code: structuredLogErrorCode(error),
      })
    );
  }
  if (scanComplete) {
    input.reconciler.start();
    startAdmissionWorkers();
    return;
  }
  input.reconciler.start({
    suppressTerminalQueueProcessingUntilSuccess: true,
    onSuccessfulScan: startAdmissionWorkers,
    ...(preserveDiscoveryCursors ? { preserveDiscoveryCursors: true } : {}),
  });
}

/** Schedule the initial scan only when the monitor exists for this topology. */
export function initializeEnvironmentHealthMonitor(
  monitor: EnvironmentHealthMonitor | null
): boolean {
  if (!monitor) return false;
  runPostStartJob('health-monitor-initialize', () => monitor.initialize());
  return true;
}

// ---------------------------------------------------------------------------
// Main startup
// ---------------------------------------------------------------------------

/**
 * Apply only the boot-time Task policy. Exported so the destructive
 * standalone compatibility path and non-destructive shared path can be
 * regression-tested without opening a listening socket.
 */
export async function prepareTaskRuntimeStartup(
  ctx: StartupContext
): Promise<OrphanCleanupResult | null> {
  if (ctx.taskRuntimePolicy !== 'standalone') return null;
  return cleanupOrphanStatuses(ctx);
}

export async function startup(ctx: StartupContext): Promise<void> {
  const {
    app,
    db,
    config,
    DAEMON_PORT,
    DAEMON_HOST,
    safeService,
    getSocketServer,
    terminalsService,
  } = ctx;

  // 1. Preserve the historical single-daemon active-runtime repair only
  // behind its explicit policy. A shared PostgreSQL replica starting is not
  // evidence that any Task, Session, queue item, or executor is orphaned.
  const orphanCleanupResult = await prepareTaskRuntimeStartup(ctx);
  if (ctx.taskRuntimePolicy !== 'standalone') {
    console.log(
      '[startup] shared PostgreSQL task runtime: startup cleanup and restart notices disabled'
    );
  }

  // 2. Construct the topology-specific environment observer before serving.
  // HA still gates lifecycle control to webhooks; this worker observes only.
  const startupMultiTenancy = resolveMultiTenancyConfig(config);
  const healthMonitor = createEnvironmentHealthMonitor(ctx);
  if (!healthMonitor) {
    throw new Error('Environment health monitor policy does not match the Task runtime policy');
  }
  app.set('environmentHealthMonitor', healthMonitor);

  // 3. Start server. Deployment secrets were resolved before service
  // registration in startDaemon(); consumers may already have captured them.
  const server = await app.listen(DAEMON_PORT, DAEMON_HOST);

  const displayHost = DAEMON_HOST === '0.0.0.0' ? 'localhost' : DAEMON_HOST;
  console.log(
    `🚀 Agor daemon running at http://${displayHost}:${DAEMON_PORT} (bound to ${DAEMON_HOST})`
  );
  console.log(
    `   health=/health auth=required services=/sessions,/tasks,/messages,/boards,/repos,/mcp-servers,/users`
  );

  initializeEnvironmentHealthMonitor(healthMonitor);

  // Non-blocking credential spill repair. If an agent/user wrote a PAT into a
  // git remote URL while the daemon was down, scrub persisted repo metadata
  // and Agor-managed repo/worktree git configs after the API is already
  // accepting requests. This is best-effort; filesystem config scrubbing
  // deliberately skips registered local repos to avoid surprising writes
  // outside Agor-managed storage.
  runPostStartJob('git-remote-credential-scrub', () =>
    runStartupTenantDatabaseScope(ctx, async () => {
      await scrubManagedGitRemoteCredentials(db);
      if (resolveMultiTenancyConfig(config).mode === 'required_from_auth') {
        // A later Cell/storage-admin reconciler must scrub physical configs:
        // one global executor cannot assume every tenant checkout is mounted.
        return;
      }
      const result = await runExecutorCommand(
        {
          command: 'git.managed-credentials.reconcile',
          sessionToken: generateScopedServiceToken(
            app as unknown as { settings: { authentication?: { secret?: string } } }
          ),
          daemonUrl: getDaemonUrl(),
          params: {},
        },
        { logPrefix: '[startup.git-credential-reconcile]' }
      );
      if (!result.success) {
        throw new Error(result.error?.message ?? 'Managed Git credential reconciliation failed');
      }
    })
  );

  // Log the host IP that will be frozen into env command templates as
  // {{host.ip_address}}. Explicit config overrides autodetection.
  runPostStartJob('host-ip-log', async () => {
    const { resolveHostIpAddress } = await import('@agor/core/utils/host-ip');
    const hostIp = resolveHostIpAddress(config.daemon?.host_ip_address);
    const source = config.daemon?.host_ip_address ? 'config' : hostIp ? 'autodetected' : 'unknown';
    startupDebug(`🌐 Host IP for env templates: ${hostIp ?? '(none)'} (source: ${source})`);
  });

  // Security warning: web terminal + simple unix mode = daemon-user shell access.
  // `allow_web_terminal` defaults to true, so the check treats undefined as enabled.
  if (config.execution?.allow_web_terminal !== false) {
    const unixMode = config.execution?.unix_user_mode ?? 'simple';
    // Delegated mode does not impersonate either: without an executor command
    // template routing terminals elsewhere, a local terminal still runs as the
    // daemon user, so the same warning applies.
    const terminalRunsAsDaemon =
      unixMode === 'simple' ||
      (unixMode === 'delegated' && !config.execution?.executor_command_template);
    if (terminalRunsAsDaemon) {
      console.warn(
        `\x1b[33m⚠️  SECURITY: allow_web_terminal is enabled (default) with unix_user_mode=${unixMode}.\x1b[0m\n` +
          '   Any member-role user can open a shell running as the daemon user, with read\n' +
          '   access to ~/.agor/config.yaml, agor.db, and the JWT secret.\n' +
          "   Recommended: set execution.unix_user_mode to 'insulated' or 'strict' to\n" +
          '   isolate terminal sessions from the daemon process, or set\n' +
          '   execution.allow_web_terminal: false to disable the web terminal entirely.'
      );
    } else {
      console.log(`🖥️  Web terminal enabled (members+, unix mode: ${unixMode})`);
    }
  }

  // 5. Start the Task-owned runtime reconciler. In shared mode every daemon
  // may discover the same routing refs; repository fences choose the winner.
  const heartbeatConfig = resolveExecutorHeartbeatConfig(config.execution);
  const taskRuntimeReconciler = new TaskRuntimeReconciler({
    app,
    db,
    config: heartbeatConfig,
    workIdentity: ctx.distributedWorkIdentity,
    tenantId:
      startupMultiTenancy.mode === 'static' ? startupMultiTenancy.static_tenant_id : undefined,
    dispatchConnectTimeoutMs: resolveDispatchConnectTimeoutMs(config.execution),
  });
  // Construct both admission workers before choosing the topology-specific
  // start point. Standalone starts neither until ordered recovery finishes.
  const queueMultiTenancy = resolveMultiTenancyConfig(config);
  const sessionQueueWorker = new SessionQueueWorker(db, {
    tenantId: queueMultiTenancy.mode === 'static' ? queueMultiTenancy.static_tenant_id : undefined,
    workIdentity: ctx.distributedWorkIdentity,
    processSession: (sessionId, params) =>
      ctx.sessionsService.triggerQueueProcessing(sessionId, params as never),
  });
  const startTaskRuntimeReconciler = (options?: TaskRuntimeReconcilerStartOptions) => {
    taskRuntimeReconciler.start(options);
    console.log(
      heartbeatConfig.enabled
        ? `💓 Task runtime reconciler started (interval: ${heartbeatConfig.interval_ms}ms, stale after: ${heartbeatConfig.stale_after_ms}ms, policy: ${ctx.taskRuntimePolicy})`
        : `💓 Task runtime reconciler started with heartbeat expiry disabled (policy: ${ctx.taskRuntimePolicy})`
    );
  };
  const startAdmissionWorkers = () => {
    sessionQueueWorker.start();
    ctx.releaseTaskAdmission?.();
  };
  const startTaskWorkers = () => {
    startTaskRuntimeReconciler();
    startAdmissionWorkers();
  };
  if (orphanCleanupResult) {
    runPostStartJob('task-runtime-recovery', () =>
      startTaskWorkersAfterRecovery({
        recover: () => resumeRuntimeRecovery(ctx, orphanCleanupResult),
        reconciler: {
          checkOnce: (options) => taskRuntimeReconciler.checkOnce(options),
          start: startTaskRuntimeReconciler,
        },
        startQueueWorker: () => sessionQueueWorker.start(),
        releaseTaskAdmission: () => ctx.releaseTaskAdmission?.(),
      })
    );
  } else {
    startTaskWorkers();
  }

  // 7. Start scheduler service (background worker)
  const schedulerMultiTenancy = resolveMultiTenancyConfig(config);
  const schedulerService = new SchedulerService(db, app, {
    deploymentPolicy: resolveDeploymentAgenticToolPolicy(config),
    tickInterval: 30000, // 30 seconds
    gracePeriod: 120000, // 2 minutes
    unixUserMode: config.execution?.unix_user_mode ?? 'simple',
    // Static mode keeps the historical single-tenant scope. Auth-resolved
    // multi-tenant mode leaves this undefined so the scheduler discovers due
    // schedule tenant metadata at the DB boundary on each tick.
    tenantId:
      schedulerMultiTenancy.mode === 'static' ? schedulerMultiTenancy.static_tenant_id : undefined,
    workIdentity: ctx.distributedWorkIdentity,
  });
  app.set('scheduler', schedulerService);
  schedulerService.start();

  // 8. Start Knowledge embedding indexer (no-op unless semantic search is configured)
  const knowledgeEmbeddingIndexer = new KnowledgeEmbeddingIndexer(db, {
    tenantId:
      startupMultiTenancy.mode === 'static' ? startupMultiTenancy.static_tenant_id : undefined,
    distributedMode:
      ctx.taskRuntimePolicy === 'shared_postgres' || startupMultiTenancy.mode !== 'static',
    workIdentity: ctx.distributedWorkIdentity,
  });
  knowledgeEmbeddingIndexer.start();
  app.set('knowledgeEmbeddingIndexer', knowledgeEmbeddingIndexer);
  console.log('🧠 Knowledge embedding indexer started');

  // 8b. Start MCP catalog ingestion. The catalog is global, so this runs once
  // per daemon regardless of tenancy mode; it enters an explicit system
  // database scope rather than any tenant's.
  const mcpCatalogIngestion = new MCPCatalogIngestionWorker(
    db,
    resolveMCPCatalogOptions(config.mcp_catalog)
  );
  mcpCatalogIngestion.start();
  app.set('mcpCatalogIngestion', mcpCatalogIngestion);
  console.log('📚 MCP catalog ingestion scheduled');

  // 9. Initialize gateway listeners. Static mode preserves the historical
  // tenant. Auth-resolved mode performs narrow global ID discovery, then
  // reloads and starts each channel under its immutable tenant identity.
  const gatewayService = safeService('gateway') as unknown as GatewayService | undefined;
  if (gatewayService) {
    const multiTenancy = resolveMultiTenancyConfig(config);
    const startGateway =
      multiTenancy.mode === 'static'
        ? runWithTenantContext(multiTenancy.static_tenant_id, () => gatewayService.startListeners())
        : gatewayService.startListenersAcrossTenants();
    void startGateway.catch((error: unknown) => {
      console.error('[gateway] Failed to start listeners:', error);
    });
  }

  // 10. Graceful shutdown handler
  const shutdown = async (signal: string) => {
    console.log(`\n⏳ Received ${signal}, shutting down gracefully...`);

    // Fail readiness before waiting on any worker drain so ingress stops
    // assigning new HTTP/Engine.IO sessions immediately.
    ctx.realtimeRuntime?.beginDrain();

    // Refuse new cost-bearing claims before any other shutdown work can wait.
    // stop() also aborts the local provider wait and drains its active DB step.
    if (knowledgeEmbeddingIndexer) {
      console.log('🧠 Stopping Knowledge embedding indexer...');
      await knowledgeEmbeddingIndexer.stop();
    }

    // The process-global sentinel is meaningful only for a standalone daemon.
    // In shared mode it cannot identify which replica owned any Task.
    if (ctx.taskRuntimePolicy === 'standalone') {
      await writeCleanShutdownSentinel(signal);
    }

    try {
      // Clean up health monitor
      await healthMonitor?.cleanup();

      // Stop Task runtime discovery before closing services.
      taskRuntimeReconciler?.stop();

      // Stop durable Session queue discovery. Any in-flight database claim is
      // still safe; stop only prevents the next local scan.
      sessionQueueWorker?.stop();

      if (shouldContainLocalExecutorsOnShutdown(ctx.taskRuntimePolicy)) {
        // Preserve the historical standalone shutdown contract.
        await containAllTrackedExecutors(app);
      } else if (ctx.taskRuntimePolicy === 'shared_postgres') {
        // A shared replica cannot discard verified process-local evidence
        // by intentionally killing an executor. A runtime may reconnect only
        // when the configured execution substrate independently survives.
        console.log(
          '🔁 Skipping local executor containment for shared-daemon handoff (substrate survival required)'
        );
      }

      // Clean up terminal sessions
      if (terminalsService) {
        console.log('🖥️  Cleaning up terminal sessions...');
        terminalsService.cleanup();
      }

      // Stop gateway listeners
      if (gatewayService) {
        console.log('🌐 Stopping gateway listeners...');
        await gatewayService.stopListeners();
      }

      console.log('📚 Stopping MCP catalog ingestion...');
      mcpCatalogIngestion.stop();

      // Stop scheduler
      if (schedulerService) {
        schedulerService.stop();
      }

      // Close Socket.io connections (this also closes the HTTP server)
      const socketServer = getSocketServer();
      if (socketServer) {
        console.log('🔌 Closing Socket.io and HTTP server...');
        if (shouldReconnectSocketClientsOnShutdown(ctx.taskRuntimePolicy)) {
          // In HA, close Engine.IO transports instead of issuing a Socket.IO
          // namespace disconnect. A namespace disconnect tells clients not to
          // reconnect; a transport close lets them retry another healthy
          // replica through ingress.
          for (const socket of socketServer.sockets.sockets.values()) {
            socket.conn.close();
          }
        } else {
          // Preserve the historical standalone shutdown contract.
          socketServer.disconnectSockets();
        }
        // Give transports a moment to close.
        await new Promise<void>((resolve) => setTimeout(resolve, 100));
        // Now close the server with a timeout
        await new Promise<void>((resolve) => {
          const timeout = setTimeout(() => {
            console.warn('⚠️  Server close timeout, forcing exit');
            resolve();
          }, 2000);

          socketServer?.close(() => {
            clearTimeout(timeout);
            console.log('✅ Server closed');
            resolve();
          });
        });
      } else {
        // Fallback: close HTTP server directly if Socket.io wasn't initialized
        await new Promise<void>((resolve, reject) => {
          server.close((err: Error | undefined) => {
            if (err) {
              console.error('❌ Error closing server:', err);
              reject(err);
            } else {
              console.log('✅ HTTP server closed');
              resolve();
            }
          });
        });
      }

      if (ctx.realtimeRuntime) {
        console.log('🔌 Closing Redis realtime clients...');
        await ctx.realtimeRuntime.close();
      }

      process.exit(0);
    } catch (error) {
      console.error('❌ Error during shutdown:', error);
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
