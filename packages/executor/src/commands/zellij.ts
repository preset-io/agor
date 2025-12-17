/**
 * Zellij Command Handlers for Executor
 *
 * These handlers manage Zellij terminal sessions for users.
 *
 * Architecture:
 * - One executor per user (spawned when user opens first terminal)
 * - Executor owns a single PTY running `zellij attach`
 * - Zellij manages multiple tabs (one per worktree)
 * - PTY I/O streams over Feathers channel: user/${userId}/terminal
 *
 * Lifecycle:
 * 1. User opens terminal modal → daemon spawns executor with zellij.attach
 * 2. Executor connects to daemon, joins user's terminal channel
 * 3. Executor spawns PTY with zellij attach
 * 4. PTY output → channel → browser; browser input → channel → PTY
 * 5. User opens another worktree → daemon sends zellij.tab command
 * 6. User closes all terminals → daemon kills executor
 */

import { spawn } from 'node:child_process';
import type { ExecutorResult, ZellijAttachPayload, ZellijTabPayload } from '../payload-types.js';
import type { AgorClient } from '../services/feathers-client.js';
import { createExecutorClient } from '../services/feathers-client.js';
import type { CommandOptions } from './index.js';

// node-pty types - imported dynamically to avoid native module issues
interface IPty {
  pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData(handler: (data: string) => void): void;
  onExit(handler: (e: { exitCode: number; signal?: number }) => void): void;
}

/**
 * Global PTY process - only one per executor instance
 * (executor is per-user, so one PTY per user)
 */
let ptyProcess: IPty | null = null;
let feathersClient: AgorClient | null = null;
let _currentUserId: string | null = null;

/**
 * Handle zellij.attach command
 *
 * Spawns PTY with zellij attach and streams I/O over Feathers channel.
 * This is a long-running command - executor stays alive until terminated.
 */
export async function handleZellijAttach(
  payload: ZellijAttachPayload,
  options: CommandOptions
): Promise<ExecutorResult> {
  const { userId, sessionName, cwd, tabName, cols, rows } = payload.params;

  // Dry run mode
  if (options.dryRun) {
    return {
      success: true,
      data: {
        dryRun: true,
        command: 'zellij.attach',
        userId,
        sessionName,
        cwd,
        tabName,
        cols,
        rows,
      },
    };
  }

  // Only one PTY per executor
  if (ptyProcess) {
    return {
      success: false,
      error: {
        code: 'PTY_ALREADY_RUNNING',
        message: 'Zellij PTY is already running in this executor',
      },
    };
  }

  try {
    // Connect to daemon
    const daemonUrl = payload.daemonUrl || 'http://localhost:3030';
    feathersClient = await createExecutorClient(daemonUrl, payload.sessionToken);
    _currentUserId = userId;

    console.log(`[zellij.attach] Connected to daemon, joining channel user/${userId}/terminal`);

    // Join the user's terminal channel
    // The daemon will route terminal events through this channel
    const socket = feathersClient.io;
    socket.emit('join', `user/${userId}/terminal`);

    // Import node-pty dynamically (native module)
    // Using @homebridge/node-pty-prebuilt-multiarch for consistency with daemon
    const nodePty = (await import('@homebridge/node-pty-prebuilt-multiarch')) as {
      spawn: (
        file: string,
        args: string[],
        options: {
          name?: string;
          cols?: number;
          rows?: number;
          cwd?: string;
          env?: Record<string, string | undefined>;
        }
      ) => IPty;
    };

    // Build zellij command
    const zellijArgs = ['attach', sessionName, '--create'];
    if (tabName) {
      // Create initial tab with name if specified
      // Note: Zellij doesn't support --tab-name on attach, we'll create it after
    }

    console.log(`[zellij.attach] Spawning PTY: zellij ${zellijArgs.join(' ')}`);
    console.log(`[zellij.attach] CWD: ${cwd}, Size: ${cols}x${rows}`);

    // Spawn PTY with zellij
    const pty = nodePty.spawn('zellij', zellijArgs, {
      name: 'xterm-256color',
      cols: cols || 80,
      rows: rows || 24,
      cwd,
      env: {
        ...process.env,
        TERM: 'xterm-256color',
        // Zellij session serialization - persist across attach/detach
        ZELLIJ_SESSION_NAME: sessionName,
      },
    });

    ptyProcess = pty;

    console.log(`[zellij.attach] PTY spawned, PID: ${pty.pid}`);

    // Stream PTY output to channel
    pty.onData((data) => {
      socket.emit('terminal:output', {
        userId,
        data,
      });
    });

    // Handle PTY exit
    pty.onExit(({ exitCode, signal }) => {
      console.log(`[zellij.attach] PTY exited: code=${exitCode}, signal=${signal}`);
      ptyProcess = null;

      // Notify daemon that terminal ended
      socket.emit('terminal:exit', {
        userId,
        exitCode,
        signal,
      });

      // Cleanup and exit
      if (feathersClient) {
        feathersClient.io.disconnect();
        feathersClient = null;
      }

      process.exit(exitCode || 0);
    });

    // Listen for input from browser via channel
    socket.on('terminal:input', (data: { userId: string; input: string }) => {
      if (data.userId === userId && ptyProcess) {
        ptyProcess.write(data.input);
      }
    });

    // Listen for resize events
    socket.on('terminal:resize', (data: { userId: string; cols: number; rows: number }) => {
      if (data.userId === userId && ptyProcess) {
        ptyProcess.resize(data.cols, data.rows);
      }
    });

    // Listen for tab commands (from daemon when user switches worktrees)
    socket.on('terminal:tab', async (data: { action: string; tabName: string; cwd?: string }) => {
      await handleTabAction(data.action, data.tabName, data.cwd);
    });

    // Create initial tab if specified
    if (tabName) {
      // Wait a moment for zellij to initialize
      setTimeout(() => {
        handleTabAction('create', tabName, cwd);
      }, 500);
    }

    // Return success - executor stays running until PTY exits
    return {
      success: true,
      data: {
        pid: pty.pid,
        sessionName,
        userId,
        channel: `user/${userId}/terminal`,
      },
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('[zellij.attach] Failed:', errorMessage);

    // Cleanup on error
    if (ptyProcess) {
      ptyProcess.kill();
      ptyProcess = null;
    }
    if (feathersClient) {
      feathersClient.io.disconnect();
      feathersClient = null;
    }

    return {
      success: false,
      error: {
        code: 'ZELLIJ_ATTACH_FAILED',
        message: errorMessage,
      },
    };
  }
}

/**
 * Handle zellij.tab command
 *
 * Creates or focuses a tab in the existing Zellij session.
 * This is sent to a running executor (not a new spawn).
 */
export async function handleZellijTab(
  payload: ZellijTabPayload,
  options: CommandOptions
): Promise<ExecutorResult> {
  const { action, tabName, cwd } = payload.params;

  // Dry run mode
  if (options.dryRun) {
    return {
      success: true,
      data: {
        dryRun: true,
        command: 'zellij.tab',
        action,
        tabName,
        cwd,
      },
    };
  }

  // Must have a running PTY
  if (!ptyProcess) {
    return {
      success: false,
      error: {
        code: 'NO_PTY_RUNNING',
        message: 'No Zellij PTY is running in this executor',
      },
    };
  }

  try {
    await handleTabAction(action, tabName, cwd);

    return {
      success: true,
      data: {
        action,
        tabName,
      },
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      error: {
        code: 'ZELLIJ_TAB_FAILED',
        message: errorMessage,
      },
    };
  }
}

/**
 * Execute a zellij action command
 *
 * Uses `zellij action` CLI to control the running session.
 */
async function handleTabAction(action: string, tabName: string, cwd?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let args: string[];

    if (action === 'create') {
      // Create new tab with specified name and cwd
      args = ['action', 'new-tab', '--name', tabName];
      if (cwd) {
        args.push('--cwd', cwd);
      }
    } else if (action === 'focus') {
      // Focus existing tab by name
      args = ['action', 'go-to-tab-name', tabName];
    } else {
      reject(new Error(`Unknown tab action: ${action}`));
      return;
    }

    console.log(`[zellij.tab] Executing: zellij ${args.join(' ')}`);

    const proc = spawn('zellij', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderr = '';
    proc.stderr?.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('exit', (code) => {
      if (code === 0) {
        console.log(`[zellij.tab] Tab action succeeded: ${action} ${tabName}`);
        resolve();
      } else {
        console.error(`[zellij.tab] Tab action failed: ${stderr}`);
        reject(new Error(`zellij action failed with code ${code}: ${stderr}`));
      }
    });

    proc.on('error', (error) => {
      reject(error);
    });
  });
}

/**
 * Cleanup function - called when executor is shutting down
 */
export function cleanupZellij(): void {
  if (ptyProcess) {
    console.log('[zellij] Killing PTY process');
    ptyProcess.kill();
    ptyProcess = null;
  }
  if (feathersClient) {
    feathersClient.io.disconnect();
    feathersClient = null;
  }
}
