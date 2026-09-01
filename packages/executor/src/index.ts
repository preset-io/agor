/**
 * AgorExecutor - New Feathers/WebSocket-based architecture
 *
 * Ephemeral executor that:
 * 1. Connects to daemon via Feathers/WebSocket
 * 2. Executes exactly one task
 * 3. Receives realtime permission resolutions while running
 * 4. Receives task-scoped Stop control events over that socket
 * 5. Exits when task completes
 *
 * The daemon persists Stop before publishing a private task-scoped control
 * event. The durable Task patch/read remains reconnect and race recovery. The
 * executor cooperatively aborts its SDK and reports quiescence; local process
 * signals and remote heartbeat recovery remain containment fallbacks.
 */

import { resolveSdkWatchdogConfig } from '@agor/core/config';
import { shortId } from '@agor/core/db';
import type {
  AgenticToolName,
  MessageSource,
  PermissionMode,
  PermissionScope,
  SessionID,
  Task,
  TaskID,
} from '@agor/core/types';
import { AUTHORIZATION_REVOKED_TERMINATION_MESSAGE, TaskStatus } from '@agor/core/types';
import { patchConsole } from '@agor/core/utils/logger';
import { type ExecutorHeartbeatHandle, startExecutorHeartbeat } from './executor-heartbeat.js';
import type { ResolvedConfigSlice } from './payload-types.js';
import { globalPermissionManager } from './permissions/permission-manager.js';
import { formatExecutorFailure } from './safe-executor-error.js';
import { getSdkActivityVersion, markSdkHealthAbort, SdkWatchdog } from './sdk-watchdog.js';
import { type AgorClient, createExecutorClient } from './services/feathers-client.js';
import { isTaskFailurePersisted, tryMarkTaskTerminal } from './terminal-task.js';
import { reportExecutorQuiescence } from './termination-report.js';
import { isDaemonOwnedAbort, markCoordinatorTerminationAbort } from './termination-state.js';

patchConsole();

const DEBUG_EXECUTOR =
  process.env.AGOR_DEBUG_EXECUTOR === '1' || process.env.DEBUG?.includes('executor');

const PROVIDER_CLEANUP_SLOW_MS = 15_000;

function executorDebug(...args: unknown[]): void {
  if (DEBUG_EXECUTOR) {
    console.debug(...args);
  }
}

type TerminationObservationSource =
  | 'connect_claim'
  | 'heartbeat'
  | 'reconnect'
  | 'startup_recovery'
  | 'task_patch'
  | 'task_stop_event'
  | 'unknown';

export interface ExecutorConfig {
  sessionToken: string;
  sessionId: string;
  taskId: string;
  prompt: string;
  tool: AgenticToolName;
  permissionMode?: PermissionMode;
  daemonUrl: string;
  messageSource?: MessageSource;
  /** Opaque, daemon-authorized context interpreted by the selected integration. */
  agenticToolContext?: Record<string, unknown>;
  /** Daemon-resolved config slice. See payload-types.ResolvedConfigSliceSchema. */
  resolvedConfig?: ResolvedConfigSlice;
}

export class AgorExecutor {
  private client: AgorClient | null = null;
  private abortController: AbortController;
  private isRunning = false;
  private heartbeat: ExecutorHeartbeatHandle | null = null;
  private watchdog: SdkWatchdog | null = null;
  private terminationRequest: Task['termination_request'];
  private terminationReport: Promise<void> | null = null;
  private terminationObservedAtMs: number | null = null;
  private providerCleanupSlowTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private config: ExecutorConfig) {
    this.abortController = new AbortController();
  }

  /**
   * Bound wrapper around the standalone `tryMarkTaskTerminal` helper for
   * the four fail-safe paths inside this class. Guards against a missing
   * client (e.g. when the daemon connection never came up).
   */
  private async tryMarkTaskTerminal(
    status: typeof TaskStatus.FAILED | typeof TaskStatus.STOPPED,
    errorMessage?: string
  ): Promise<void> {
    if (!this.client || isDaemonOwnedAbort(this.abortController)) return;
    await tryMarkTaskTerminal(this.client, this.config.taskId, status, errorMessage);
  }

  /**
   * Start the executor process
   */
  async start(): Promise<void> {
    const uid = typeof process.getuid === 'function' ? process.getuid() : 'N/A';
    console.log(
      `[executor] Starting ${this.config.tool} task ${shortId(this.config.taskId)} ` +
        `for session ${shortId(this.config.sessionId)} as ${process.env.USER || 'unknown'} (uid: ${uid})`
    );

    try {
      // Connect to daemon via Feathers/WebSocket
      executorDebug('[executor] Connecting to daemon via Feathers...');
      this.client = await createExecutorClient(this.config.daemonUrl, this.config.sessionToken, {
        onReconnected: () => this.refreshTerminationState('reconnect'),
      });
      executorDebug('[executor] Connected to daemon');

      // Register before claiming so Stop cannot fall into the connect → listen
      // gap. The durable-state refresh in the catch path covers Stop that won
      // before this socket authenticated.
      this.setupEventListeners();
      this.setupShutdownHandlers();

      // Authentication is complete. Atomically claim the daemon-dispatched task
      // before starting heartbeats or SDK work; a late executor cannot revive a
      // stopped or terminal task.
      const connectedTask = await this.client
        .service('tasks')
        .connectExecutor({ task_id: this.config.taskId });
      this.handleTaskLifecycleUpdate(connectedTask, 'connect_claim');

      // Execute the task
      if (!this.terminationRequest) await this.executeTask();
      await this.reportTerminationComplete();

      // Exit successfully
      console.log(
        `[executor.lifecycle] event=exit_requested task_id=${shortId(this.config.taskId)} ` +
          `code=0 reason=${this.terminationRequest ? 'termination_complete' : 'task_complete'}`
      );
      process.exit(0);
    } catch (error) {
      if (isTaskFailurePersisted(error)) {
        console.log(
          `[executor.lifecycle] event=exit_requested task_id=${shortId(this.config.taskId)} ` +
            'code=1 reason=task_failure_persisted'
        );
        process.exit(1);
        return;
      }
      const terminationRecovered = await this.recoverTerminationAfterExecutionError();
      if (terminationRecovered) {
        console.log(
          `[executor.lifecycle] event=exit_requested task_id=${shortId(this.config.taskId)} ` +
            'code=0 reason=termination_recovered'
        );
        process.exit(0);
        return;
      }
      console.error(
        `[executor] fatal error category=${this.terminationRequest ? 'termination_report' : 'task_startup'}`
      );
      await this.tryMarkTaskTerminal(TaskStatus.FAILED, formatExecutorFailure(error));
      process.exit(1);
    }
  }

  /**
   * Setup event listeners for WebSocket events
   *
   * Task lifecycle patches are already durable and realtime, so Stop needs no
   * second ephemeral command channel. Reconnect recovery reads the same Task.
   */
  private setupEventListeners(): void {
    if (!this.client) return;

    this.client.service('tasks').on('patched', (data: unknown) => {
      this.handleTaskLifecycleUpdate(data as Task, 'task_patch');
    });
    this.client.service('tasks').on('termination_requested', (data: unknown) => {
      this.handleTaskLifecycleUpdate(data as Task, 'task_stop_event');
    });

    // Listen for permission_resolved events
    this.client.service('messages').on('permission_resolved', (data: unknown) => {
      const event = data as {
        requestId: string;
        taskId: string;
        sessionId: string;
        allow: boolean;
        reason?: string;
        remember: boolean;
        scope: string;
        decidedBy: string;
      };
      console.log('[executor] Received permission_resolved event:', event);

      if (event.taskId === this.config.taskId && event.sessionId === this.config.sessionId) {
        this.recordPulse('sdk_started', 'permission.resolved');
        // Forward to global permission manager
        globalPermissionManager.resolvePermission({
          requestId: event.requestId,
          taskId: event.taskId as TaskID,
          allow: event.allow,
          reason: event.reason,
          remember: event.remember,
          scope: event.scope as PermissionScope,
          decidedBy: event.decidedBy,
        });
      }
    });

    executorDebug('[executor] Event listeners registered');
  }

  private handleTaskLifecycleUpdate(
    task: Task,
    source: TerminationObservationSource = 'unknown'
  ): void {
    if (
      task.task_id !== this.config.taskId ||
      task.status !== TaskStatus.STOPPING ||
      !task.termination_request
    ) {
      return;
    }
    if (this.terminationRequest?.requested_at === task.termination_request.requested_at) return;

    this.terminationRequest = task.termination_request;
    this.terminationObservedAtMs = Date.now();
    console.log(
      `[executor.stop] event=request_observed task_id=${shortId(this.config.taskId)} ` +
        `cause=${task.termination_request.cause} source=${source}`
    );
    if (task.termination_request.cause === 'authorization_revoked') {
      console.warn(AUTHORIZATION_REVOKED_TERMINATION_MESSAGE);
    }
    markCoordinatorTerminationAbort(this.abortController);
    // Keep task-scoped heartbeat/pulse reporting alive until ToolRegistry.execute
    // and provider cleanup actually return. STOPPING is still live work; hiding
    // its liveness here makes a slow or ignored cancellation indistinguishable
    // from a dead executor. executeTask's finally stops telemetry immediately
    // before the quiescence acknowledgement.
    if (this.watchdog) {
      this.watchdog.stop();
      console.log(`[executor.stop] event=watchdog_stopped task_id=${shortId(this.config.taskId)}`);
    }
    this.watchdog = null;
    this.abortController.abort();
    console.log(
      `[executor.stop] event=provider_abort_requested task_id=${shortId(this.config.taskId)}`
    );
    if (this.isRunning && !this.providerCleanupSlowTimer) {
      this.providerCleanupSlowTimer = setTimeout(() => {
        this.providerCleanupSlowTimer = null;
        if (!this.isRunning || !this.terminationRequest) return;
        console.warn(
          `[executor.stop] event=provider_cleanup_slow task_id=${shortId(this.config.taskId)} ` +
            `elapsed_ms=${PROVIDER_CLEANUP_SLOW_MS}`
        );
      }, PROVIDER_CLEANUP_SLOW_MS);
      this.providerCleanupSlowTimer.unref?.();
    }
  }

  private async refreshTerminationState(source: TerminationObservationSource): Promise<void> {
    if (!this.client) return;
    const task = (await this.client.service('tasks').get(this.config.taskId)) as Task;
    this.handleTaskLifecycleUpdate(task, source);
  }

  private async reportTerminationComplete(): Promise<void> {
    if (!this.client || !this.terminationRequest) return;
    if (!this.terminationReport) {
      const client = this.client;
      const requestedAt = this.terminationRequest.requested_at;
      const report = reportExecutorQuiescence({
        taskId: this.config.taskId,
        requestedAt,
        report: () =>
          client.service('tasks').reportTerminationComplete({
            task_id: this.config.taskId,
            requested_at: requestedAt,
          }),
        readTask: () => client.service('tasks').get(this.config.taskId) as Promise<Task>,
      });
      this.terminationReport = report;
    }
    await this.terminationReport;
  }

  /**
   * A provider commonly rejects when its AbortSignal fires. Treat that as a
   * successful cooperative Stop only after the exact request is durably
   * acknowledged. The startup refresh covers the connect/Stop race where the
   * socket event arrived before this process claimed the Task.
   */
  private async recoverTerminationAfterExecutionError(): Promise<boolean> {
    if (!this.terminationRequest) return this.recoverTerminationBeforeStart();
    try {
      await this.reportTerminationComplete();
      return true;
    } catch {
      return false;
    }
  }

  /** Handle Stop that atomically beat connectExecutor() without starting SDK work. */
  private async recoverTerminationBeforeStart(): Promise<boolean> {
    if (!this.client) return false;
    try {
      await this.refreshTerminationState('startup_recovery');
      if (!this.terminationRequest) return false;
      await this.reportTerminationComplete();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Execute the task using the appropriate SDK
   */
  private async executeTask(): Promise<void> {
    if (!this.client) {
      throw new Error('Feathers client not initialized');
    }
    if (this.terminationRequest || this.abortController.signal.aborted) return;

    this.isRunning = true;

    const heartbeatConfig = this.config.resolvedConfig?.execution?.executor_heartbeat;
    this.heartbeat = startExecutorHeartbeat({
      client: this.client,
      taskId: this.config.taskId,
      enabled: heartbeatConfig?.enabled ?? true,
      intervalMs: heartbeatConfig?.interval_ms,
      onTask: (task) => this.handleTaskLifecycleUpdate(task, 'heartbeat'),
    });
    const watchdogConfig =
      this.config.resolvedConfig?.execution?.sdk_watchdog ?? resolveSdkWatchdogConfig();
    if (this.config.tool !== 'cursor' && this.config.tool !== 'workload') {
      this.watchdog = new SdkWatchdog({
        tool: this.config.tool,
        config: watchdogConfig,
        sdkVersion: getSdkActivityVersion(this.config.tool),
        onDecision: (evidence) => this.handleWatchdogDecision(evidence),
      });
      // Start at the executor boundary so imports, subscriptions, prompt
      // submission, and a silent first SDK event are all covered.
      this.recordPulse('sdk_started', this.config.tool);
    }

    executorDebug(`[executor] Executing task with ${this.config.tool}...`);

    try {
      // Import and initialize tool registry
      const { ToolRegistry, initializeToolRegistry } = await import(
        './handlers/sdk/tool-registry.js'
      );
      await initializeToolRegistry(this.config.tool);

      // Execute using registry
      await ToolRegistry.execute(this.config.tool, {
        client: this.client,
        sessionId: this.config.sessionId as SessionID,
        taskId: this.config.taskId as TaskID,
        prompt: this.config.prompt,
        permissionMode: this.config.permissionMode,
        abortController: this.abortController,
        messageSource: this.config.messageSource,
        agenticToolContext: this.config.agenticToolContext,
        resolvedConfig: this.config.resolvedConfig,
        onPulse: (kind, detail) => this.recordPulse(kind, detail),
      });
    } finally {
      if (this.providerCleanupSlowTimer) {
        clearTimeout(this.providerCleanupSlowTimer);
        this.providerCleanupSlowTimer = null;
      }
      if (this.terminationRequest) {
        const elapsedMs = Math.max(0, Date.now() - (this.terminationObservedAtMs ?? Date.now()));
        console.log(
          `[executor.stop] event=provider_cleanup_settled task_id=${shortId(this.config.taskId)} ` +
            `elapsed_ms=${elapsedMs}`
        );
      }
      this.watchdog?.stop();
      this.watchdog = null;
      if (this.heartbeat) {
        this.heartbeat.stop();
        if (this.terminationRequest) {
          console.log(
            `[executor.stop] event=runtime_telemetry_stopped task_id=${shortId(this.config.taskId)}`
          );
        }
      }
      this.heartbeat = null;
      this.isRunning = false;
    }
  }

  private recordPulse(
    kind: Parameters<ExecutorHeartbeatHandle['recordPulse']>[0],
    detail?: string
  ) {
    this.heartbeat?.recordPulse(kind, detail);
    this.watchdog?.record(kind, detail);
  }

  private async handleWatchdogDecision(
    evidence: Omit<import('@agor/core/types').SdkHealthFailureInput, 'task_id'>
  ): Promise<void> {
    if (!this.client) return;
    let acknowledged = false;
    const report = this.client
      .service('tasks')
      .reportSdkHealthFailure({ ...evidence, task_id: this.config.taskId })
      .then((task) => {
        acknowledged = true;
        this.handleTaskLifecycleUpdate(task);
      })
      .catch((error) => console.error('[executor] Failed to report SDK health:', error));
    if (evidence.watchdog_action !== 'enforced') {
      await report;
      return;
    }

    let deadline: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      report,
      new Promise<void>((resolve) => {
        deadline = setTimeout(resolve, 2_000);
        deadline.unref?.();
      }),
    ]);
    if (deadline) clearTimeout(deadline);
    markSdkHealthAbort(this.abortController);
    if (!acknowledged) {
      this.heartbeat?.stop();
      this.heartbeat = null;
      const abortGraceMs =
        this.config.resolvedConfig?.execution?.sdk_watchdog?.abort_grace_ms ??
        resolveSdkWatchdogConfig().abort_grace_ms;
      const exitDeadline = setTimeout(() => {
        if (acknowledged) return;
        console.error(
          '[executor] SDK health report remained unacknowledged; exiting for containment'
        );
        process.exit(70);
      }, abortGraceMs);
      exitDeadline.unref?.();
    }
  }

  /**
   * Setup graceful shutdown handlers
   */
  private setupShutdownHandlers(): void {
    process.once('exit', (code) => {
      console.log(
        `[executor.lifecycle] event=process_exit task_id=${shortId(this.config.taskId)} code=${code}`
      );
    });

    const shutdown = async (signal: string) => {
      console.log(`[executor] Received ${signal}, shutting down...`);

      // Abort any running task
      if (this.isRunning) {
        this.abortController.abort();
      }
      this.heartbeat?.stop();
      this.heartbeat = null;
      this.watchdog?.stop();
      this.watchdog = null;

      // The daemon's termination coordinator owns STOPPING → terminal. This
      // fallback only fires for an out-of-band signal while the task is active.
      await this.tryMarkTaskTerminal(TaskStatus.STOPPED);

      console.log(
        `[executor.lifecycle] event=exit_requested task_id=${shortId(this.config.taskId)} ` +
          `code=0 reason=signal_${signal.toLowerCase()}`
      );
      process.exit(0);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

    process.on('uncaughtException', async (error) => {
      console.error('[executor] Uncaught exception:', error);
      await this.tryMarkTaskTerminal(
        TaskStatus.FAILED,
        `uncaughtException: ${error instanceof Error ? error.message : String(error)}`
      );
      process.exit(1);
    });

    process.on('unhandledRejection', async (reason) => {
      console.error('[executor] Unhandled rejection:', reason);
      await this.tryMarkTaskTerminal(
        TaskStatus.FAILED,
        `unhandledRejection: ${reason instanceof Error ? reason.message : String(reason)}`
      );
      process.exit(1);
    });
  }
}

// Re-export types and utilities
export * from './types.js';
