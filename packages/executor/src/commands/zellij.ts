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
let currentPtyCols = 160;
let currentPtyRows = 40;

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
  const { userId, sessionName, cwd, tabName, cols, rows, envFile } = payload.params;

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

    // Handle socket disconnect gracefully
    // This happens when daemon restarts (watch mode) - just exit cleanly
    // A new executor will be spawned when user reopens terminal
    socket.on('disconnect', (reason: string) => {
      console.log(`[zellij.attach] Socket disconnected: ${reason}`);
      // Clean up and exit gracefully instead of crashing
      if (ptyProcess) {
        ptyProcess.kill();
        ptyProcess = null;
      }
      process.exit(0);
    });

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

    // Build zellij command - config path added after fs/actualHome are defined below
    const zellijArgs = ['attach', sessionName, '--create'];

    // Build clean environment for Zellij
    // CRITICAL: Strip existing Zellij env vars to prevent "attach to current session" error
    // This happens when executor is spawned from within a Zellij session (legacy terminal mode)
    const cleanEnv = { ...process.env };
    delete cleanEnv.ZELLIJ;
    delete cleanEnv.ZELLIJ_SESSION_NAME;
    delete cleanEnv.ZELLIJ_PANE_ID;

    // Get actual home directory and shell for current user from passwd
    // os.homedir() doesn't work correctly with sudo impersonation - it returns the original user's home
    // We must use getent passwd to get the correct values for the impersonated user
    const fs = await import('node:fs');
    const { execSync } = await import('node:child_process');

    let actualHome = '/tmp'; // Fallback
    let userShell = '/bin/bash'; // Fallback
    try {
      const passwdEntry = execSync(`getent passwd $(whoami)`, { encoding: 'utf-8' }).trim();
      const fields = passwdEntry.split(':');
      // passwd format: name:password:uid:gid:gecos:home:shell
      if (fields.length >= 6 && fields[5]) {
        actualHome = fields[5];
      }
      if (fields.length >= 7 && fields[6]) {
        userShell = fields[6];
      }
    } catch (err) {
      console.error(`[zellij.attach] Failed to get user info from passwd:`, err);
    }
    console.log(`[zellij.attach] User home: ${actualHome}, shell: ${userShell}`);

    // Ensure Zellij cache directory exists - useradd -m creates home but not .cache/zellij
    // Zellij needs this for plugin data, session info, and session serialization
    const zellijCacheDir = `${actualHome}/.cache/zellij`;
    if (!fs.existsSync(zellijCacheDir)) {
      console.log(`[zellij.attach] Creating Zellij cache directory: ${zellijCacheDir}`);
      fs.mkdirSync(zellijCacheDir, { recursive: true });
    }

    // Zellij will use ~/.config/zellij/config.kdl by default
    // The docker entrypoint copies Agor's default config there on user creation
    // Users can customize their config as needed

    console.log(`[zellij.attach] Spawning PTY: zellij ${zellijArgs.join(' ')}`);
    console.log(`[zellij.attach] CWD: ${cwd}, Size: ${cols}x${rows}`);

    // Spawn PTY with zellij
    const pty = nodePty.spawn('zellij', zellijArgs, {
      name: 'xterm-256color',
      cols: cols || 80,
      rows: rows || 24,
      cwd,
      env: {
        ...cleanEnv,
        TERM: 'xterm-256color',
        SHELL: userShell, // Explicit shell - Zellij needs this to spawn terminal panes
        HOME: actualHome, // Ensure Zellij uses correct home for cache/config
        XDG_CACHE_HOME: `${actualHome}/.cache`, // Explicit cache dir
        XDG_CONFIG_HOME: `${actualHome}/.config`, // Explicit config dir
      },
    });

    ptyProcess = pty;
    currentSessionName = sessionName; // Store for tab management
    currentPtyCols = cols || 80;
    currentPtyRows = rows || 24;

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
        currentPtyCols = data.cols;
        currentPtyRows = data.rows;
        ptyProcess.resize(data.cols, data.rows);
      }
    });

    // Listen for tab commands (from daemon when user switches worktrees)
    socket.on('terminal:tab', async (data: { action: string; tabName: string; cwd?: string }) => {
      await handleTabAction(data.action, data.tabName, data.cwd);
    });

    // Listen for redraw requests (when client reconnects)
    // Trigger resize to force Zellij to redraw via SIGWINCH
    socket.on('terminal:redraw', (data: { userId: string }) => {
      if (data.userId === userId && ptyProcess) {
        ptyProcess.resize(currentPtyCols, currentPtyRows);
      }
    });

    // Create initial tab if specified
    if (tabName) {
      // Wait a moment for zellij to initialize
      setTimeout(() => {
        handleTabAction('create', tabName, cwd);
      }, 500);
    }

    // Source env file after Zellij initializes (user env vars like API keys)
    if (envFile && ptyProcess) {
      // Wait for shell to be ready, then source env file
      setTimeout(() => {
        if (ptyProcess) {
          // Source the env file silently (suppress output, ignore errors if file doesn't exist)
          const sourceCmd = `[ -f '${envFile}' ] && source '${envFile}' 2>/dev/null; clear\r`;
          ptyProcess.write(sourceCmd);
          console.log(`[zellij.attach] Sourced env file: ${envFile}`);
        }
      }, 800); // Wait longer than tab creation to ensure shell is ready
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
 * Current Zellij session name (set when attach starts)
 */
let currentSessionName: string | null = null;

/**
 * Query existing tab names from Zellij session
 */
async function queryTabNames(): Promise<string[]> {
  if (!currentSessionName) {
    console.warn('[zellij.tab] No session name set, cannot query tabs');
    return [];
  }

  const sessionName = currentSessionName; // Capture for closure
  return new Promise((resolve) => {
    // Must specify --session to query the correct Zellij session
    const proc = spawn('zellij', ['--session', sessionName, 'action', 'query-tab-names'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    proc.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    // Add timeout to prevent hanging
    const timeout = setTimeout(() => {
      proc.kill();
      console.warn('[zellij.tab] query-tab-names timed out');
      resolve([]);
    }, 3000);

    proc.on('exit', (code: number | null) => {
      clearTimeout(timeout);
      if (code === 0) {
        const tabs = stdout
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line.length > 0);
        resolve(tabs);
      } else {
        // On error, return empty - we'll try to create the tab
        resolve([]);
      }
    });

    proc.on('error', () => {
      clearTimeout(timeout);
      resolve([]);
    });
  });
}

/**
 * Execute a zellij action command
 *
 * Uses `zellij action` CLI to control the running session.
 * For 'create' action, checks if tab exists first and focuses instead.
 */
async function handleTabAction(action: string, tabName: string, cwd?: string): Promise<void> {
  if (!currentSessionName) {
    console.error('[zellij.tab] No session name set, cannot perform tab action');
    return;
  }

  // For create action, check if tab already exists - if so, focus it instead
  if (action === 'create') {
    const existingTabs = await queryTabNames();
    if (existingTabs.includes(tabName)) {
      console.log(`[zellij.tab] Tab "${tabName}" already exists, focusing instead of creating`);
      action = 'focus';
    }
  }

  const sessionName = currentSessionName; // Capture for closure
  return new Promise((resolve, reject) => {
    // Build args with session specified
    let actionArgs: string[];

    if (action === 'create') {
      // Create new tab with specified name and cwd
      actionArgs = ['new-tab', '--name', tabName];
      if (cwd) {
        actionArgs.push('--cwd', cwd);
      }
    } else if (action === 'focus') {
      // Focus existing tab by name
      actionArgs = ['go-to-tab-name', tabName];
    } else {
      reject(new Error(`Unknown tab action: ${action}`));
      return;
    }

    // Always specify --session to target correct Zellij instance
    const args = ['--session', sessionName, 'action', ...actionArgs];

    console.log(`[zellij.tab] Executing: zellij ${args.join(' ')}`);

    const proc = spawn('zellij', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderr = '';
    proc.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    // Add timeout to prevent hanging
    const timeout = setTimeout(() => {
      proc.kill();
      console.error(`[zellij.tab] Tab action timed out: ${action} ${tabName}`);
      reject(new Error(`zellij action timed out`));
    }, 5000);

    proc.on('exit', (code: number | null) => {
      clearTimeout(timeout);
      if (code === 0) {
        console.log(`[zellij.tab] Tab action succeeded: ${action} ${tabName}`);
        resolve();
      } else {
        console.error(`[zellij.tab] Tab action failed: ${stderr}`);
        reject(new Error(`zellij action failed with code ${code}: ${stderr}`));
      }
    });

    proc.on('error', (error: Error) => {
      clearTimeout(timeout);
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
  currentSessionName = null;
}
