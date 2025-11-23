/**
 * ExecutorPool - Manages executor subprocess lifecycle
 * Spawns executors with Unix user impersonation (via sudo)
 */

import { type ChildProcess, execSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ExecutorClient } from './executor-client';
import type {
  ExecutorIPCService,
  GetApiKeyParams,
  ReportMessageParams,
  RequestPermissionParams,
} from './executor-ipc-service';

interface SpawnExecutorOptions {
  userId?: string; // Agor user ID (for looking up Unix username)
  unixUsername?: string; // Direct Unix username override
  worktreeId?: string; // Optional worktree context
}

interface ExecutorInstance {
  id: string;
  userId?: string;
  unixUsername: string | null;
  socketPath: string;
  process: ChildProcess;
  client: ExecutorClient;
  createdAt: Date;
}

type ImpersonationMode = 'sudo' | 'disabled';

export class ExecutorPool {
  private executors = new Map<string, ExecutorInstance>();
  private impersonationMode: ImpersonationMode;
  private executorBinary: string;

  constructor(
    private config: { execution?: { run_as_unix_user?: boolean; executor_unix_user?: string } },
    private ipcService?: ExecutorIPCService
  ) {
    // Detect impersonation mode once at startup
    this.impersonationMode = this.detectImpersonationMode();

    // Find executor binary
    this.executorBinary = this.findExecutorBinary();

    console.log(`[ExecutorPool] Impersonation mode: ${this.impersonationMode}`);
    console.log(`[ExecutorPool] Executor binary: ${this.executorBinary}`);
  }

  /**
   * Spawn a new executor subprocess
   */
  async spawn(options: SpawnExecutorOptions = {}): Promise<ExecutorInstance> {
    const { unixUsername, userId } = options;
    // worktreeId reserved for future use (environment isolation)
    const _worktreeId = options.worktreeId;
    if (_worktreeId) {
      console.log(`[ExecutorPool] Worktree context: ${_worktreeId}`);
    }

    // Determine Unix username
    const targetUsername = unixUsername || this.config.execution?.executor_unix_user || null;

    // Generate socket path
    const socketPath = `/tmp/agor-executor-${randomUUID()}.sock`;

    // Build spawn command
    const { command, args } = this.buildSpawnCommand(targetUsername, socketPath);

    console.log(`[ExecutorPool] Spawning executor: ${command} ${args.join(' ')}`);

    // Spawn subprocess
    const childProcess = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: process.cwd(), // Set working directory to daemon's cwd (workspace root)
      env: {
        ...process.env, // Pass full environment (includes API keys, HOME, etc.)
        // Override HOME for the target user if needed
        ...(targetUsername && { HOME: `/home/${targetUsername}` }),
      },
    });

    // Setup logging
    childProcess.stdout?.on('data', (data) => {
      const lines = data.toString().split('\n').filter(Boolean);
      for (const line of lines) {
        console.log(`[executor:${childProcess.pid}] ${line}`);
      }
    });

    childProcess.stderr?.on('data', (data) => {
      const lines = data.toString().split('\n').filter(Boolean);
      for (const line of lines) {
        console.error(`[executor:${childProcess.pid}] ${line}`);
      }
    });

    const executorId = randomUUID();

    childProcess.on('exit', (code, signal) => {
      console.log(`[ExecutorPool] Executor ${executorId} exited: code=${code}, signal=${signal}`);
      this.executors.delete(executorId);
    });

    // Wait for socket to be ready
    await this.waitForSocket(socketPath, 5000);

    // Connect to executor
    const client = new ExecutorClient(socketPath);
    await client.connect();

    // Wire up IPC handlers if service provided
    if (this.ipcService) {
      this.setupIPCHandlers(client);
    }

    // Create executor instance
    const executor: ExecutorInstance = {
      id: executorId,
      userId,
      unixUsername: targetUsername,
      socketPath,
      process: childProcess,
      client,
      createdAt: new Date(),
    };

    this.executors.set(executorId, executor);

    console.log(
      `[ExecutorPool] Executor ${executorId} ready (user=${targetUsername || 'current'})`
    );

    return executor;
  }

  /**
   * Get an executor by ID
   */
  get(executorId: string): ExecutorInstance | undefined {
    return this.executors.get(executorId);
  }

  /**
   * Terminate an executor
   */
  async terminate(executorId: string): Promise<void> {
    const executor = this.executors.get(executorId);
    if (!executor) {
      return;
    }

    console.log(`[ExecutorPool] Terminating executor ${executorId}`);

    // Try graceful shutdown first
    try {
      await executor.client.request('shutdown', { timeout_ms: 5000 }, 5000);
    } catch (_error) {
      // Force kill if graceful shutdown fails
      console.warn(`[ExecutorPool] Graceful shutdown failed, force killing`);
      executor.process.kill('SIGTERM');
    }

    await executor.client.disconnect();
    this.executors.delete(executorId);
  }

  /**
   * Terminate all executors
   */
  async terminateAll(): Promise<void> {
    const terminations = Array.from(this.executors.keys()).map((id) => this.terminate(id));
    await Promise.all(terminations);
  }

  /**
   * Get all active executors
   */
  getAll(): ExecutorInstance[] {
    return Array.from(this.executors.values());
  }

  /**
   * Build spawn command with impersonation
   */
  private buildSpawnCommand(
    unixUsername: string | null,
    socketPath: string
  ): { command: string; args: string[] } {
    const executorArgs = ['--socket', socketPath];

    // Determine if we're running compiled JS or TypeScript source
    const isCompiledJS = this.executorBinary.endsWith('.js');
    const nodeArgs = isCompiledJS
      ? ['node', this.executorBinary, ...executorArgs]
      : ['npx', 'tsx', this.executorBinary, ...executorArgs];

    // No impersonation (run as current user)
    if (!unixUsername || this.impersonationMode === 'disabled') {
      return {
        command: nodeArgs[0],
        args: nodeArgs.slice(1),
      };
    }

    // Sudo-based impersonation
    return {
      command: 'sudo',
      args: [
        '-n', // Non-interactive (fail if password required)
        '-u',
        unixUsername, // Target user
        ...nodeArgs,
      ],
    };
  }

  /**
   * Detect which impersonation mode is available
   */
  private detectImpersonationMode(): ImpersonationMode {
    // Check if execution.run_as_unix_user is enabled
    if (!this.config.execution?.run_as_unix_user) {
      return 'disabled';
    }

    // Check for sudo access
    try {
      // Try to check if we can run sudo commands
      execSync('sudo -n -l', { stdio: 'ignore' });
      return 'sudo';
    } catch {
      console.warn('[ExecutorPool] Impersonation configured but sudo not available');
      return 'disabled';
    }
  }

  /**
   * Find executor binary path
   */
  private findExecutorBinary(): string {
    // Try to find executor relative to current working directory
    // This works both in development and Docker
    const cwd = process.cwd();

    // Try monorepo structure - prefer compiled dist over source
    // Using compiled JS avoids tsx ESM issues with packages like @openai/codex-sdk
    const relativeFromDaemonDist = path.join(cwd, '../../packages/executor/dist/cli.js');
    if (fs.existsSync(relativeFromDaemonDist)) {
      return relativeFromDaemonDist;
    }

    // Try from workspace root - compiled dist
    const relativeFromRootDist = path.join(cwd, 'packages/executor/dist/cli.js');
    if (fs.existsSync(relativeFromRootDist)) {
      return relativeFromRootDist;
    }

    // Fallback to TypeScript source (for development when not compiled)
    const relativeFromDaemon = path.join(cwd, '../../packages/executor/src/cli.ts');
    if (fs.existsSync(relativeFromDaemon)) {
      return relativeFromDaemon;
    }

    const relativeFromRoot = path.join(cwd, 'packages/executor/src/cli.ts');
    if (fs.existsSync(relativeFromRoot)) {
      return relativeFromRoot;
    }

    // Fallback to assuming it's in PATH (production install)
    return 'agor-executor';
  }

  /**
   * Wait for Unix socket to exist
   */
  private async waitForSocket(socketPath: string, timeoutMs: number): Promise<void> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      if (fs.existsSync(socketPath)) {
        // Socket exists, wait a bit more to ensure it's listening
        await new Promise((resolve) => setTimeout(resolve, 100));
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    throw new Error(`Executor socket not ready: ${socketPath}`);
  }

  /**
   * Setup IPC handlers for executor requests
   */
  private setupIPCHandlers(client: ExecutorClient): void {
    if (!this.ipcService) {
      return;
    }

    // Handle get_api_key requests from executor
    client.onRequest('get_api_key', async (params) => {
      return await this.ipcService!.handleGetApiKey(params as GetApiKeyParams);
    });

    // Handle request_permission requests from executor
    client.onRequest('request_permission', async (params) => {
      return await this.ipcService!.handleRequestPermission(params as RequestPermissionParams);
    });

    // Handle report_message notifications from executor
    client.onNotification('report_message', async (params) => {
      await this.ipcService!.handleReportMessage(params as ReportMessageParams);
    });

    // Handle daemon_command notifications from executor
    client.onNotification('daemon_command', async (params) => {
      await this.ipcService!.handleDaemonCommand(
        params as import('./executor-ipc-service').DaemonCommandParams
      );
    });

    console.log(`[ExecutorPool] IPC handlers registered`);
  }
}
