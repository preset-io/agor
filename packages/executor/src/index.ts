/**
 * AgorExecutor - New Feathers/WebSocket-based architecture
 *
 * Ephemeral executor that:
 * 1. Connects to daemon via Feathers/WebSocket
 * 2. Executes exactly one task
 * 3. Listens for stop events while running
 * 4. Exits when task completes
 */

import { resolveSdkWatchdogConfig } from '@agor/core/config';
import { shortId } from '@agor/core/db';
import type {
  MessageSource,
  PermissionMode,
  PermissionScope,
  SessionID,
  TaskID,
} from '@agor/core/types';
import { TaskStatus } from '@agor/core/types';
import { patchConsole } from '@agor/core/utils/logger';
import { type ExecutorHeartbeatHandle, startExecutorHeartbeat } from './executor-heartbeat.js';
import type { ResolvedConfigSlice } from './payload-types.js';
import { globalPermissionManager } from './permissions/permission-manager.js';
import {
  getSdkActivityVersion,
  isSdkHealthAbort,
  markSdkHealthAbort,
  SdkWatchdog,
} from './sdk-watchdog.js';
import { type AgorClient, createFeathersClient } from './services/feathers-client.js';
import { tryMarkTaskTerminal } from './terminal-task.js';

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
  /** Daemon-resolved config slice. See payload-types.ResolvedConfigSliceSchema. */
  resolvedConfig?: ResolvedConfigSlice;
}

export class AgorExecutor {
  private client: AgorClient | null = null;
  private abortController: AbortController;
  private isRunning = false;
  private heartbeat: ExecutorHeartbeatHandle | null = null;
  private watchdog: SdkWatchdog | null = null;

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
    if (!this.client || isSdkHealthAbort(this.abortController)) return;
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
      this.client = await createFeathersClient(this.config.daemonUrl, this.config.sessionToken);
      executorDebug('[executor] Connected to daemon');

      // Authentication is complete. Atomically claim the daemon-dispatched task
      // before starting heartbeats or SDK work; a late executor cannot revive a
      // stopped or terminal task.
      await this.client.service('tasks').connectExecutor({ task_id: this.config.taskId });

      // Setup event listeners
      this.setupEventListeners();

      // Setup graceful shutdown handlers
      this.setupShutdownHandlers();

      // Execute the task
      await this.executeTask();

      // Exit successfully
      console.log('[executor] Task completed, exiting');
      process.exit(0);
    } catch (error) {
      console.error('[executor] Fatal error:', error);
      await this.tryMarkTaskTerminal(
        TaskStatus.FAILED,
        error instanceof Error ? error.message : String(error)
      );
      process.exit(1);
    }
  }

  /**
   * Setup event listeners for WebSocket events
   *
   * Stop signaling is handled via Unix signals (SIGTERM/SIGKILL) from the daemon,
   * not WebSocket events. The SIGTERM handler in setupShutdownHandlers() calls
   * abortController.abort() for graceful shutdown.
   */
  private setupEventListeners(): void {
    if (!this.client) return;

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

  /**
   * Execute the task using the appropriate SDK
   */
  private async executeTask(): Promise<void> {
    if (!this.client) {
      throw new Error('Feathers client not initialized');
    }

    this.isRunning = true;

    const heartbeatConfig = this.config.resolvedConfig?.execution?.executor_heartbeat;
    this.heartbeat = startExecutorHeartbeat({
      client: this.client,
      taskId: this.config.taskId,
      enabled: heartbeatConfig?.enabled ?? true,
      intervalMs: heartbeatConfig?.interval_ms,
    });
    const watchdogConfig =
      this.config.resolvedConfig?.execution?.sdk_watchdog ?? resolveSdkWatchdogConfig();
    if (this.config.tool !== 'cursor') {
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
      await initializeToolRegistry();

      // Execute using registry
      await ToolRegistry.execute(this.config.tool, {
        client: this.client,
        sessionId: this.config.sessionId as SessionID,
        taskId: this.config.taskId as TaskID,
        prompt: this.config.prompt,
        permissionMode: this.config.permissionMode,
        abortController: this.abortController,
        messageSource: this.config.messageSource,
        resolvedConfig: this.config.resolvedConfig,
        onPulse: (kind, detail) => this.recordPulse(kind, detail),
      });
    } finally {
      this.watchdog?.stop();
      this.watchdog = null;
      this.heartbeat?.stop();
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
      .then(() => {
        acknowledged = true;
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
