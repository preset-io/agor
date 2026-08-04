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
  MessageSource,
  PermissionMode,
  PermissionScope,
  SessionID,
  Task,
  TaskID,
} from '@agor/core/types';
import { isTerminalTaskStatus, TaskStatus } from '@agor/core/types';
import { patchConsole } from '@agor/core/utils/logger';
import { type ExecutorHeartbeatHandle, startExecutorHeartbeat } from './executor-heartbeat.js';
import type { InteractionMode, ResolvedConfigSlice } from './payload-types.js';
import { globalPermissionManager } from './permissions/permission-manager.js';
import {
  activityToPulse,
  applyAdapterConformanceMode,
  getSdkActivityConformance,
  markSdkHealthAbort,
  type RuntimeActivity,
  SdkWatchdog,
} from './sdk-watchdog.js';
import { type AgorClient, createFeathersClient } from './services/feathers-client.js';
import {
  type AgenticToolOutcome,
  finalizeTask as persistTaskOutcome,
  requestContainment as reportContainmentRequired,
  tryRequestContainment,
} from './terminal-task.js';
import { isDaemonOwnedAbort, markCoordinatorTerminationAbort } from './termination-state.js';

patchConsole();

const DEBUG_EXECUTOR =
  process.env.AGOR_DEBUG_EXECUTOR === '1' || process.env.DEBUG?.includes('executor');

function executorDebug(...args: unknown[]): void {
  if (DEBUG_EXECUTOR) {
    console.debug(...args);
  }
}

export interface ExecutorConfig {
  sessionToken: string;
  sessionId: string;
  taskId: string;
  prompt: string;
  tool: 'claude-code' | 'gemini' | 'codex' | 'opencode' | 'copilot' | 'cursor';
  permissionMode?: PermissionMode;
  daemonUrl: string;
  messageSource?: MessageSource;
  /** Opaque, daemon-authorized context interpreted by the selected integration. */
  agenticToolContext?: Record<string, unknown>;
  interactionMode?: InteractionMode;
  /** Daemon-resolved config slice. See payload-types.ResolvedConfigSliceSchema. */
  resolvedConfig?: ResolvedConfigSlice;
}

export class AgorExecutor {
  private client: AgorClient | null = null;
  private abortController: AbortController;
  private isRunning = false;
  private heartbeat: ExecutorHeartbeatHandle | null = null;
  private watchdog: SdkWatchdog | null = null;
  private latestPulseSequence?: number;
  private terminationRequest: Task['termination_request'];
  private terminationReport: Promise<void> | null = null;

  constructor(private config: ExecutorConfig) {
    this.abortController = new AbortController();
  }

  /**
   * Cooperative outcomes and process fail-safes converge on one writer.
   * Normal callers reach it only after runtime quiescence; daemon-owned
   * termination and enforced watchdog aborts deliberately bypass it.
   */
  private async finalizeTask(outcome: AgenticToolOutcome): Promise<void> {
    if (!this.client || isDaemonOwnedAbort(this.abortController)) return;
    await persistTaskOutcome(this.client, this.config.taskId, outcome);
  }

  private async requestContainment(error: unknown, bestEffort = false): Promise<void> {
    if (!this.client || isDaemonOwnedAbort(this.abortController)) return;
    if (bestEffort) {
      await tryRequestContainment(this.client, this.config.taskId, error);
      return;
    }
    await reportContainmentRequired(this.client, this.config.taskId, error);
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
      this.client = await createFeathersClient(this.config.daemonUrl, this.config.sessionToken, {
        onReauthenticated: () => this.refreshTerminationState(),
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
      this.handleTaskLifecycleUpdate(connectedTask);

      // Execute the task
      if (!this.terminationRequest) await this.executeTask();
      await this.reportTerminationComplete();

      // Exit successfully
      console.log('[executor] Task completed, exiting');
      process.exit(0);
    } catch (error) {
      if (await this.recoverTerminationBeforeStart()) {
        process.exit(0);
        return;
      }
      console.error('[executor] Fatal error:', error);
      await this.requestContainment(error, true);
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
      this.handleTaskLifecycleUpdate(data as Task);
    });
    this.client.service('tasks').on('termination_requested', (data: unknown) => {
      this.handleTaskLifecycleUpdate(data as Task);
    });

    // Listen for permission_resolved events
    this.client.service('messages').on('permission_resolved', (data: unknown) => {
      const event = data as {
        requestId: string;
        taskId: string;
        allow: boolean;
        reason?: string;
        remember: boolean;
        scope: string;
        decidedBy: string;
      };
      console.log('[executor] Received permission_resolved event:', event);

      if (event.taskId === this.config.taskId) {
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

  private handleTaskLifecycleUpdate(task: Task): void {
    if (task.task_id !== this.config.taskId) return;
    if (isTerminalTaskStatus(task.status)) {
      if (!this.abortController.signal.aborted) {
        console.warn(
          `[executor] Daemon reports Task ${shortId(task.task_id)} is already ${task.status}; relinquishing runtime ownership`
        );
      }
      this.relinquishRuntimeOwnership();
      return;
    }
    if (task.status !== TaskStatus.STOPPING || !task.termination_request) return;
    if (this.terminationRequest?.requested_at === task.termination_request.requested_at) return;

    this.terminationRequest = task.termination_request;
    console.log(
      `[executor] Received ${task.termination_request.cause} termination request; stopping SDK`
    );
    this.relinquishRuntimeOwnership();
  }

  private relinquishRuntimeOwnership(): void {
    markCoordinatorTerminationAbort(this.abortController);
    this.heartbeat?.stop();
    this.heartbeat = null;
    this.watchdog?.stop();
    this.watchdog = null;
    this.abortController.abort();
  }

  private async refreshTerminationState(): Promise<void> {
    if (!this.client) return;
    const task = (await this.client.service('tasks').get(this.config.taskId)) as Task;
    this.handleTaskLifecycleUpdate(task);
  }

  private async reportTerminationComplete(): Promise<void> {
    if (!this.client || !this.terminationRequest) return;
    if (!this.terminationReport) {
      const report = this.client
        .service('tasks')
        .reportTerminationComplete({
          task_id: this.config.taskId,
          requested_at: this.terminationRequest.requested_at,
        })
        .then(() => {
          console.log('[executor] Cooperative termination complete');
        });
      this.terminationReport = report;
      void report.catch(() => {
        if (this.terminationReport === report) this.terminationReport = null;
      });
    }
    await this.terminationReport;
  }

  /** Handle Stop that atomically beat connectExecutor() without starting SDK work. */
  private async recoverTerminationBeforeStart(): Promise<boolean> {
    if (!this.client) return false;
    try {
      await this.refreshTerminationState();
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
      onTask: (task) => this.handleTaskLifecycleUpdate(task),
      onReportError: () => this.refreshTerminationState(),
    });
    const watchdogConfig =
      this.config.resolvedConfig?.execution?.sdk_watchdog ?? resolveSdkWatchdogConfig();
    const conformance = getSdkActivityConformance(this.config.tool);
    if (!conformance) throw new Error(`Missing runtime conformance for ${this.config.tool}`);
    this.watchdog = new SdkWatchdog({
      tool: this.config.tool,
      config: {
        ...watchdogConfig,
        mode: applyAdapterConformanceMode(watchdogConfig.mode, conformance.mode),
      },
      sdkVersion: conformance.version,
      onDecision: (evidence) => this.handleWatchdogDecision(evidence),
    });
    // Start at the executor boundary so imports, subscriptions, prompt
    // submission, and a silent first SDK event are all covered.
    this.recordActivity({ type: 'sdk_started', detail: this.config.tool });

    executorDebug(`[executor] Executing task with ${this.config.tool}...`);

    let outcome: AgenticToolOutcome | undefined;
    try {
      // Import and initialize tool registry
      const { ToolRegistry, initializeToolRegistry } = await import(
        './handlers/sdk/tool-registry.js'
      );
      await initializeToolRegistry();

      // Execute using registry
      outcome = await ToolRegistry.execute(this.config.tool, {
        client: this.client,
        sessionId: this.config.sessionId as SessionID,
        taskId: this.config.taskId as TaskID,
        prompt: this.config.prompt,
        permissionMode: this.config.permissionMode,
        abortController: this.abortController,
        messageSource: this.config.messageSource,
        agenticToolContext: this.config.agenticToolContext,
        resolvedConfig: this.config.resolvedConfig,
        onActivity: (activity) => this.recordActivity(activity),
        interactionMode: this.config.interactionMode,
      });

      if (!outcome || isDaemonOwnedAbort(this.abortController)) return;
      await this.finalizeTask(outcome);
      if (outcome.error) throw outcome.error;
    } finally {
      this.watchdog?.stop();
      this.watchdog = null;
      this.heartbeat?.stop();
      this.heartbeat = null;
      this.isRunning = false;
    }
  }

  private recordActivity(activity: RuntimeActivity): void {
    const observedActivity = this.watchdog?.record(activity) ?? activity;
    const pulse = activityToPulse(observedActivity);
    this.latestPulseSequence = this.heartbeat?.recordPulse(pulse.kind, pulse.detail);
  }

  private async handleWatchdogDecision(
    evidence: Omit<import('@agor/core/types').SdkHealthFailureInput, 'task_id'>
  ): Promise<void> {
    if (!this.client) return;
    let acknowledged = false;
    const report = this.client
      .service('tasks')
      .reportSdkHealthFailure({
        ...evidence,
        task_id: this.config.taskId,
        ...(this.latestPulseSequence === undefined
          ? {}
          : { pulse_sequence_at_detection: this.latestPulseSequence }),
      })
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
    const shutdown = async (signal: string) => {
      console.log(`[executor] Received ${signal}, shutting down...`);

      if (this.isRunning) {
        this.abortController.abort();
        // Let the normal execution/finalization path await provider cleanup.
        // If it cannot return, exiting without a terminal write leaves the
        // daemon's liveness/containment owners to settle the Task safely.
        const graceMs =
          this.config.resolvedConfig?.execution?.sdk_watchdog?.abort_grace_ms ??
          resolveSdkWatchdogConfig().abort_grace_ms;
        const deadline = setTimeout(() => process.exit(70), graceMs);
        deadline.unref?.();
        return;
      }
      process.exit(0);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

    process.on('uncaughtException', async (error) => {
      console.error('[executor] Uncaught exception:', error);
      this.abortController.abort();
      await this.requestContainment(
        new Error(`uncaughtException: ${error instanceof Error ? error.message : String(error)}`),
        true
      );
      process.exit(1);
    });

    process.on('unhandledRejection', async (reason) => {
      console.error('[executor] Unhandled rejection:', reason);
      this.abortController.abort();
      await this.requestContainment(
        new Error(
          `unhandledRejection: ${reason instanceof Error ? reason.message : String(reason)}`
        ),
        true
      );
      process.exit(1);
    });
  }
}

// Re-export types and utilities
export * from './types.js';
