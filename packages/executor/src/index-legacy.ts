/**
 * AgorExecutor - Main entry point for executor process
 * Receives IPC requests from daemon and executes them in isolated context
 */

import { handleExecutePrompt } from './handlers/execute-prompt.js';
import { handlePing } from './handlers/ping.js';
import { ExecutorIPCServer } from './ipc-server.js';
import { globalPermissionManager } from './permissions/permission-manager.js';
import type {
  ExecutePromptParams,
  JSONRPCNotification,
  JSONRPCRequest,
  PingParams,
  ResponseHelper,
} from './types';

/**
 * LEGACY: IPC-based executor (will be removed after migration)
 */
export class AgorExecutorLegacy {
  private ipcServer: ExecutorIPCServer | null = null;

  constructor(private socketPath: string) {}

  /**
   * Start the executor process
   */
  async start(): Promise<void> {
    console.log('[executor] Starting Agor Executor');
    const uid = typeof process.getuid === 'function' ? process.getuid() : 'N/A';
    console.log(`[executor] User: ${process.env.USER || 'unknown'} (uid: ${uid})`);
    console.log(`[executor] Socket: ${this.socketPath}`);

    // Create IPC server
    this.ipcServer = new ExecutorIPCServer(this.socketPath, this.handleRequest.bind(this));

    // Register global permission_resolved listener
    this.ipcServer.on('permission_resolved', (decision) => {
      console.log(`[executor] Received permission_resolved notification`);
      globalPermissionManager.resolvePermission(decision);
    });

    // Start listening
    await this.ipcServer.start();

    console.log('[executor] Ready for connections');

    // Setup graceful shutdown
    this.setupShutdownHandlers();
  }

  /**
   * Handle incoming requests from daemon
   */
  private async handleRequest(
    message: JSONRPCRequest | JSONRPCNotification,
    respond: ResponseHelper
  ): Promise<void> {
    const { method, params } = message;

    console.log(`[executor] Received: ${method}`);

    try {
      let result: unknown;

      switch (method) {
        case 'ping':
          result = await handlePing((params || {}) as PingParams);
          break;

        case 'execute_prompt':
          if (!this.ipcServer) {
            throw new Error('IPC server not initialized');
          }
          console.log('[executor] Calling handleExecutePrompt...');
          result = await handleExecutePrompt(params as ExecutePromptParams, this.ipcServer);
          console.log('[executor] handleExecutePrompt returned:', result);
          break;

        // Future handlers:
        // case 'spawn_terminal':
        //   result = await handleSpawnTerminal(params);
        //   break;

        default:
          respond.error(-32601, `Unknown method: ${method}`);
          return;
      }

      // Send success response (only for requests with id)
      if ('id' in message) {
        console.log(`[executor] Handler succeeded for ${method}, sending success response`);
        respond.success(result);
      }
    } catch (error) {
      const err = error as Error;
      console.error(`[executor] Handler error for ${method}:`, err);
      console.log(`[executor] Sending error response for ${method}`);

      if ('id' in message) {
        respond.error(-32000, err.message || 'Handler error', {
          stack: err.stack,
        });
      }
    }
  }

  /**
   * Setup graceful shutdown handlers
   */
  private setupShutdownHandlers(): void {
    const shutdown = async (signal: string) => {
      console.log(`[executor] Received ${signal}, shutting down...`);

      if (this.ipcServer) {
        await this.ipcServer.stop();
      }

      process.exit(0);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

    process.on('uncaughtException', (error) => {
      console.error('[executor] Uncaught exception:', error);
      process.exit(1);
    });

    process.on('unhandledRejection', (reason) => {
      console.error('[executor] Unhandled rejection:', reason);
      process.exit(1);
    });
  }

  /**
   * Stop the executor
   */
  async stop(): Promise<void> {
    if (this.ipcServer) {
      await this.ipcServer.stop();
    }
  }
}

export { ExecutorIPCServer } from './ipc-server.js';
// Re-export types and utilities
export * from './types.js';
