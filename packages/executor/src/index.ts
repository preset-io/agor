/**
 * AgorExecutor - New Feathers/WebSocket-based architecture
 *
 * Ephemeral executor that:
 * 1. Connects to daemon via Feathers/WebSocket
 * 2. Executes exactly one task
 * 3. Listens for stop events while running
 * 4. Exits when task completes
 */

import { shortId } from '@agor/core/db';
import type {
  MessageSource,
  PermissionMode,
  PermissionScope,
  SessionID,
  Task,
  TaskID,
} from '@agor/core/types';
import { TaskStatus } from '@agor/core/types';
import type { ResolvedConfigSlice } from './payload-types.js';
import { globalPermissionManager } from './permissions/permission-manager.js';
import { type AgorClient, createFeathersClient } from './services/feathers-client.js';

/**
 * Statuses past which any subsequent terminal-write is a no-op. SDK
 * handlers (base-executor) write rich terminal patches with timing /
 * `git_state.sha_at_end`; once we've stamped one of those, the
 * fail-safe catches below should NOT redundantly emit a second
 * `'patched'` event for the same task. Includes `TIMED_OUT` so a
 * subsequent uncaught-rejection/SIGTERM doesn't overwrite a
 * permission/input timeout with `FAILED` or `STOPPED`.
 */
export const TERMINAL_STATUSES: ReadonlySet<Task['status']> = new Set<Task['status']>([
  TaskStatus.COMPLETED,
  TaskStatus.FAILED,
  TaskStatus.STOPPED,
  TaskStatus.TIMED_OUT,
]);

/**
 * Patch a task to a terminal status, but ONLY if the task is not already
 * terminal. The SDK handlers in base-executor are authoritative — they
 * stamp the full payload (timing, `git_state.sha_at_end`, normalized SDK
 * responses). The fail-safe paths in `AgorExecutor` (top-level catch,
 * signal handler, uncaughtException, unhandledRejection) are pure
 * fallbacks for when the inner path never ran; if it did, this helper
 * skips the patch so we don't emit a redundant `'patched'` event for
 * the same task.
 *
 * Exported standalone (rather than left as a private method) so the
 * idempotence behavior can be unit-tested directly without spinning up
 * an `AgorExecutor` instance.
 */
export async function tryMarkTaskTerminal(
  client: AgorClient,
  taskId: string,
  status: typeof TaskStatus.FAILED | typeof TaskStatus.STOPPED,
  errorMessage?: string
): Promise<void> {
  try {
    const current = (await client.service('tasks').get(taskId)) as Task;
    if (TERMINAL_STATUSES.has(current.status)) {
      console.log(
        `[executor] Task ${shortId(taskId)} already terminal (${current.status}), skipping ${status} patch`
      );
      return;
    }
    await client.service('tasks').patch(taskId, {
      status,
      completed_at: new Date().toISOString(),
      ...(errorMessage ? { error_message: errorMessage } : {}),
    });
  } catch (patchError) {
    console.error('[executor] Failed to update task status:', patchError);
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
    if (!this.client) return;
    await tryMarkTaskTerminal(this.client, this.config.taskId, status, errorMessage);
  }

  /**
   * Start the executor process
   */
  async start(): Promise<void> {
    console.log('[executor] Starting Agor Executor (Feathers mode)');
    const uid = typeof process.getuid === 'function' ? process.getuid() : 'N/A';
    console.log(`[executor] User: ${process.env.USER || 'unknown'} (uid: ${uid})`);
    console.log(`[executor] Session: ${shortId(this.config.sessionId)}`);
    console.log(`[executor] Task: ${shortId(this.config.taskId)}`);
    console.log(`[executor] Tool: ${this.config.tool}`);
    console.log(`[executor] Daemon: ${this.config.daemonUrl}`);

    try {
      // Connect to daemon via Feathers/WebSocket
      console.log('[executor] Connecting to daemon via Feathers...');
      this.client = await createFeathersClient(this.config.daemonUrl, this.config.sessionToken);
      console.log('[executor] Connected to daemon');

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

    console.log('[executor] Event listeners registered');
  }

  /**
   * Execute the task using the appropriate SDK
   */
  private async executeTask(): Promise<void> {
    if (!this.client) {
      throw new Error('Feathers client not initialized');
    }

    this.isRunning = true;

    console.log(`[executor] Executing task with ${this.config.tool}...`);

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
    });

    this.isRunning = false;
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

      // The daemon's stop route already patches the task to STOPPED before
      // sending the signal — this fallback only fires if we received an
      // out-of-band signal and the task is still active.
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
