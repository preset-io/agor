/**
 * AgorExecutor - New Feathers/WebSocket-based architecture
 *
 * Ephemeral executor that:
 * 1. Connects to daemon via Feathers/WebSocket
 * 2. Executes exactly one task
 * 3. Listens for stop events while running
 * 4. Exits when task completes
 */

import type { PermissionScope, SessionID, TaskID } from '@agor/core/types';
import { globalPermissionManager } from './permissions/permission-manager.js';
import { type AgorClient, createFeathersClient } from './services/feathers-client.js';

export interface ExecutorConfig {
  sessionToken: string;
  sessionId: string;
  taskId: string;
  prompt: string;
  tool: 'claude-code' | 'gemini' | 'codex' | 'opencode';
  permissionMode?: 'ask' | 'auto' | 'allow-all';
  daemonUrl: string;
}

export class AgorExecutor {
  private client: AgorClient | null = null;
  private abortController: AbortController;
  private isRunning = false;

  constructor(private config: ExecutorConfig) {
    this.abortController = new AbortController();
  }

  /**
   * Start the executor process
   */
  async start(): Promise<void> {
    console.log('[executor] Starting Agor Executor (Feathers mode)');
    const uid = typeof process.getuid === 'function' ? process.getuid() : 'N/A';
    console.log(`[executor] User: ${process.env.USER || 'unknown'} (uid: ${uid})`);
    console.log(`[executor] Session: ${this.config.sessionId.substring(0, 8)}`);
    console.log(`[executor] Task: ${this.config.taskId.substring(0, 8)}`);
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

      // Try to update task status to FAILED
      if (this.client) {
        try {
          await this.client.service('tasks').patch(this.config.taskId, {
            status: 'failed',
            completed_at: new Date().toISOString(),
          });
        } catch (patchError) {
          console.error('[executor] Failed to update task status:', patchError);
        }
      }

      process.exit(1);
    }
  }

  /**
   * Setup event listeners for WebSocket events
   */
  private setupEventListeners(): void {
    if (!this.client) return;

    // Listen for task_stop events
    // biome-ignore lint/suspicious/noExplicitAny: Feathers types don't support custom events
    (this.client.service('sessions') as any).on(
      'task_stop',
      async (data: {
        session_id: string;
        task_id: string;
        sequence: number;
        timestamp: string;
      }) => {
        console.log('[executor] Received task_stop event:', data);

        if (data.session_id === this.config.sessionId && data.task_id === this.config.taskId) {
          // IMMEDIATELY send acknowledgment (before stopping)
          try {
            // biome-ignore lint/suspicious/noExplicitAny: Feathers types don't support custom events
            (this.client!.service('sessions') as any).emit('task_stop_ack', {
              session_id: data.session_id,
              task_id: data.task_id,
              sequence: data.sequence,
              received_at: new Date().toISOString(),
              status: 'stopping',
            });
            console.log(`✅ [executor] Sent stop ACK (seq ${data.sequence})`);
          } catch (error) {
            console.error('❌ [executor] Failed to send stop ACK:', error);
          }

          // Now initiate the stop
          console.log('[executor] Stop signal received, aborting execution');
          this.abortController.abort();
        }
      }
    );

    // Listen for permission_resolved events
    // biome-ignore lint/suspicious/noExplicitAny: Feathers types don't support custom events
    (this.client.service('messages') as any).on(
      'permission_resolved',
      (data: {
        requestId: string;
        taskId: string;
        allow: boolean;
        reason?: string;
        remember: boolean;
        scope: string;
        decidedBy: string;
      }) => {
        console.log('[executor] Received permission_resolved event:', data);

        if (data.taskId === this.config.taskId) {
          // Forward to global permission manager
          globalPermissionManager.resolvePermission({
            requestId: data.requestId,
            taskId: data.taskId as TaskID,
            allow: data.allow,
            reason: data.reason,
            remember: data.remember,
            scope: data.scope as PermissionScope,
            decidedBy: data.decidedBy,
          });
        }
      }
    );

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

      // Update task status to stopped
      if (this.client) {
        try {
          await this.client.service('tasks').patch(this.config.taskId, {
            status: 'stopped',
            completed_at: new Date().toISOString(),
          });
        } catch (error) {
          console.error('[executor] Failed to update task status:', error);
        }
      }

      process.exit(0);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

    process.on('uncaughtException', async (error) => {
      console.error('[executor] Uncaught exception:', error);

      // Try to update task status
      if (this.client) {
        try {
          await this.client.service('tasks').patch(this.config.taskId, {
            status: 'failed',
            completed_at: new Date().toISOString(),
          });
        } catch (patchError) {
          console.error('[executor] Failed to update task status:', patchError);
        }
      }

      process.exit(1);
    });

    process.on('unhandledRejection', async (reason) => {
      console.error('[executor] Unhandled rejection:', reason);

      // Try to update task status
      if (this.client) {
        try {
          await this.client.service('tasks').patch(this.config.taskId, {
            status: 'failed',
            completed_at: new Date().toISOString(),
          });
        } catch (patchError) {
          console.error('[executor] Failed to update task status:', patchError);
        }
      }

      process.exit(1);
    });
  }
}

// Re-export types and utilities
export * from './types.js';
