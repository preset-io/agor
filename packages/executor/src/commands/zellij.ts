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
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { IPty } from 'node-pty';
import type { ExecutorResult, ZellijAttachPayload, ZellijTabPayload } from '../payload-types.js';
import type { AgorClient } from '../services/feathers-client.js';
import { createExecutorClient } from '../services/feathers-client.js';
import type { CommandOptions } from './index.js';

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
    // Using upstream microsoft/node-pty (no engines cap, supports Node 24/25)
    const nodePty: typeof import('node-pty') = await import('node-pty');

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

    // Listen for tab commands (from daemon when user switches worktrees
    // OR when a `claude-code-cli` session is created — the daemon passes
    // `command` + `commandArgs` so the new tab spawns the `claude` binary
    // directly into its foreground process).
    socket.on(
      'terminal:tab',
      async (data: {
        action: string;
        tabName: string;
        cwd?: string;
        command?: string;
        commandArgs?: string[];
      }) => {
        await handleTabAction(
          data.action,
          data.tabName,
          data.cwd,
          data.command,
          data.commandArgs
        );
      }
    );

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
  const { action, tabName, cwd, command, commandArgs } = payload.params;

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
        tabCommand: command,
        tabCommandArgs: commandArgs,
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
    await handleTabAction(action, tabName, cwd, command, commandArgs);

    return {
      success: true,
      data: {
        action,
        tabName,
        spawnedCommand: command,
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
 *
 * When `command` is supplied on a `create` action, the new tab spawns
 * the named binary instead of the user's default shell. This is how the
 * Claude Code CLI adapter drops the user into an interactive `claude`
 * REPL inside a Zellij pane — see
 * docs/internal/claude-code-cli-integration-analysis-2026-05-14.md §
 * "Spawn shape".
 */
async function handleTabAction(
  action: string,
  tabName: string,
  cwd?: string,
  command?: string,
  commandArgs?: string[]
): Promise<void> {
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
      if (command) {
        // Zellij's `action new-tab` does NOT accept `--command` directly
        // (its only flags are `--name`, `--cwd`, `--layout`). To spawn a
        // specific binary as the new tab's foreground pane we materialize
        // a tiny per-tab KDL layout file declaring a single pane that
        // runs the command, then pass `--layout <file>`. The layout file
        // lives under /tmp and is best-effort cleaned at handler return —
        // Zellij has already parsed and started the pane by then.
        const layoutPath = writeClaudeLayoutFile(tabName, cwd, command, commandArgs ?? []);
        actionArgs.push('--layout', layoutPath);
      }
    } else if (action === 'focus') {
      // Focus existing tab by name
      actionArgs = ['go-to-tab-name', tabName];
    } else if (action === 'close') {
      // Close-by-name isn't a Zellij action directly; the safe sequence
      // is `go-to-tab-name <X>` followed by `close-tab`. If the tab
      // doesn't exist `go-to-tab-name` errors and we just skip the
      // close — Zellij prints a warning, not a fatal error.
      // Implemented as two sequential `zellij action ...` calls below.
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
        // 'close' is a two-phase action: focus the tab, then close-tab.
        // Run the second phase here so the caller's promise resolves
        // when the tab is actually gone.
        if (action === 'close') {
          const closeProc = spawn(
            'zellij',
            ['--session', sessionName, 'action', 'close-tab'],
            { stdio: ['ignore', 'pipe', 'pipe'] }
          );
          let closeStderr = '';
          closeProc.stderr?.on('data', (d: Buffer) => {
            closeStderr += d.toString();
          });
          const closeTimeout = setTimeout(() => {
            closeProc.kill();
            console.warn(`[zellij.tab] close-tab timed out for ${tabName}`);
            resolve();
          }, 3000);
          closeProc.on('exit', (closeCode) => {
            clearTimeout(closeTimeout);
            if (closeCode !== 0) {
              console.warn(`[zellij.tab] close-tab failed (code ${closeCode}): ${closeStderr}`);
            } else {
              console.log(`[zellij.tab] Tab closed: ${tabName}`);
            }
            resolve();
          });
          closeProc.on('error', () => {
            clearTimeout(closeTimeout);
            resolve();
          });
        } else {
          resolve();
        }
      } else {
        console.error(`[zellij.tab] Tab action failed: ${stderr}`);
        // 'close' is best-effort — don't fail the caller's promise if
        // the target tab was already gone.
        if (action === 'close') {
          console.warn(
            `[zellij.tab] close action failed (likely tab "${tabName}" didn't exist) — proceeding`
          );
          resolve();
        } else {
          reject(new Error(`zellij action failed with code ${code}: ${stderr}`));
        }
      }
    });

    proc.on('error', (error: Error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

/**
 * Materialize a Zellij KDL layout file describing one pane that runs a
 * specific binary with the given argv. Used by the Claude Code CLI
 * adapter to spawn `claude` into a freshly-created tab.
 *
 * Layout shape (KDL):
 *
 *   layout {
 *     pane command="claude" cwd="..." {
 *       args "--session-id" "..." "-n" "cli-..." "--permission-mode" "acceptEdits" ...
 *     }
 *   }
 *
 * Returns the absolute path of the written file. The file is left on disk
 * after Zellij parses it — Zellij reads it synchronously during the
 * `action new-tab --layout <file>` call, so cleanup is optional. We keep
 * it under `/tmp/agor-zellij-layouts/` for easy diagnosis if a spawn
 * misbehaves.
 */
function writeClaudeLayoutFile(
  tabName: string,
  cwd: string | undefined,
  command: string,
  commandArgs: string[]
): string {
  const dir = '/tmp/agor-zellij-layouts';
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const filePath = path.join(dir, `${tabName}-${Date.now()}.kdl`);
  // KDL string-escaping: backslashes and double-quotes only. Each argv
  // element becomes a separate quoted token inside `args`.
  const escape = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  const argsLine =
    commandArgs.length > 0 ? `        args ${commandArgs.map(escape).join(' ')}\n` : '';
  const cwdAttr = cwd ? ` cwd=${escape(cwd)}` : '';
  const layout = `layout {
    pane command=${escape(command)}${cwdAttr} {
${argsLine}    }
}
`;
  fs.writeFileSync(filePath, layout, { mode: 0o600 });
  return filePath;
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
