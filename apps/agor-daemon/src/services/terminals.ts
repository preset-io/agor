/**
 * Terminals Service
 *
 * Manages Zellij-based terminal sessions for web-based terminal access.
 * REQUIRES Zellij to be installed on the system.
 *
 * Features:
 * - Full terminal emulation (vim, nano, htop, etc.)
 * - Job control (Ctrl+C, Ctrl+Z)
 * - Terminal resizing via node-pty
 * - ANSI colors and escape codes
 * - Persistent sessions via Zellij (survive daemon restarts)
 * - One session per user, one tab per worktree
 *
 * Architecture:
 * - node-pty for PTY allocation (Zellij requires TTY)
 * - Zellij for session/tab multiplexing
 * - Zellij CLI actions for tab/session management
 * - xterm.js frontend for rendering
 */

import { exec, execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import {
  createUserProcessEnvironment,
  loadConfig,
  resolveUserEnvironment,
} from '@agor/core/config';

import { type Database, formatShortId, UsersRepository, WorktreeRepository } from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import type { AuthenticatedParams, UserID, WorktreeID } from '@agor/core/types';
import {
  buildSpawnArgs,
  resolveUnixUserForImpersonation,
  type UnixUserMode,
  UnixUserNotFoundError,
  validateResolvedUnixUser,
} from '@agor/core/unix';
import * as pty from '@homebridge/node-pty-prebuilt-multiarch';

// Promisify exec for async usage
const execAsync = promisify(exec);

/**
 * Default timeout for Zellij operations in milliseconds
 * 5 seconds is enough for any Zellij command - if it takes longer, something is wrong
 * This prevents the daemon from freezing if Zellij hangs
 */
const ZELLIJ_COMMAND_TIMEOUT_MS = 5000;

/**
 * Batching interval for PTY output in milliseconds
 * 10ms provides good balance between responsiveness and reducing WebSocket overhead
 */
const DATA_BATCH_INTERVAL_MS = 10;

/**
 * Cache TTL for Zellij tab lists in milliseconds
 * 5 seconds is enough to avoid repeated queries during session setup
 */
const TAB_CACHE_TTL_MS = 5000;

/**
 * Timeout for waiting for PTY ready signal in milliseconds
 * 3 seconds is generous but prevents indefinite waiting if something goes wrong
 */
const READY_TIMEOUT_MS = 3000;

/**
 * Maximum buffer size for PTY output batching in bytes
 * Prevents unbounded memory growth if WebSocket is slow
 * At 1MB, force flush regardless of timer
 */
const MAX_BUFFER_SIZE = 1024 * 1024;

interface TerminalSession {
  terminalId: string;
  pty: pty.IPty;
  shell: string;
  cwd: string;
  userId?: UserID; // User context for env resolution
  worktreeId?: WorktreeID; // Worktree context for Zellij session naming
  zellijSession: string; // Zellij session name (always required)
  cols: number;
  rows: number;
  createdAt: Date;
  env: Record<string, string>; // User environment variables
  batcher: TerminalDataBatcher; // Batches PTY output to reduce WebSocket overhead
}

interface CreateTerminalData {
  cwd?: string;
  shell?: string;
  rows?: number;
  cols?: number;
  userId?: UserID; // User context for env resolution
  worktreeId?: WorktreeID; // Worktree context for Zellij integration
}

interface ResizeTerminalData {
  rows: number;
  cols: number;
}

/**
 * Escape a string for safe use in shell commands
 * Uses single quotes which prevent all expansions except for single quotes themselves
 * Single quotes within the string are handled by closing the quote, escaping the quote, and reopening
 * Example: foo'bar becomes 'foo'\''bar'
 */
function escapeShellArg(arg: string): string {
  // Replace each single quote with '\'' (close quote, escaped quote, open quote)
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

/**
 * Escape a string for use within double quotes in shell commands
 * Used for Zellij action arguments like tab names, paths, and write-chars content
 * Must escape: backslashes, double quotes, dollar signs, backticks
 */
function escapeDoubleQuoted(str: string): string {
  return str
    .replace(/\\/g, '\\\\') // Escape backslashes first
    .replace(/"/g, '\\"') // Escape double quotes
    .replace(/\$/g, '\\$') // Escape dollar signs (prevent variable expansion)
    .replace(/`/g, '\\`'); // Escape backticks (prevent command substitution)
}

/**
 * Check if Zellij is installed
 */
function isZellijAvailable(): boolean {
  try {
    execSync('which zellij', { stdio: 'pipe', timeout: 2000 });
    return true;
  } catch {
    return false;
  }
}

// =============================================================================
// ASYNC ZELLIJ UTILITIES
// These replace the blocking sync versions to prevent event loop blocking
// =============================================================================

/**
 * Run a shell command asynchronously, optionally as another Unix user
 * This is the async equivalent of runAsUser from @agor/core/unix
 */
async function runAsUserAsync(
  command: string,
  options: { asUser?: string; timeout?: number } = {}
): Promise<string> {
  const { asUser, timeout = ZELLIJ_COMMAND_TIMEOUT_MS } = options;

  let fullCommand: string;

  if (asUser) {
    // Impersonate: use sudo su - for fresh group memberships
    const escapedCommand = escapeShellArg(command);
    fullCommand = `sudo -n su - ${asUser} -c ${escapedCommand}`;
  } else {
    fullCommand = command;
  }

  const { stdout } = await execAsync(fullCommand, { timeout });
  return stdout;
}

/**
 * Async check if a Zellij session exists
 */
async function zellijSessionExistsAsync(sessionName: string, asUser?: string): Promise<boolean> {
  try {
    const output = await runAsUserAsync('zellij list-sessions 2>/dev/null', {
      asUser,
      timeout: ZELLIJ_COMMAND_TIMEOUT_MS,
    });
    // Match exact session name by splitting lines (avoids "agor-abc" matching "agor-abcde")
    const sessions = output.split('\n').map((line) => line.trim());
    return sessions.includes(sessionName);
  } catch (error) {
    const isTimeout = error instanceof Error && error.message.includes('ETIMEDOUT');
    if (isTimeout) {
      console.warn(`[Zellij] Timeout checking session ${sessionName} - Zellij may be stuck`);
    }
    return false;
  }
}

/**
 * Async run a Zellij CLI action on a specific session
 * @param throwOnError - If true, propagates errors instead of swallowing them (use for critical operations)
 */
async function runZellijActionAsync(
  sessionName: string,
  action: string,
  asUser?: string,
  throwOnError = false
): Promise<void> {
  try {
    const cmd = `zellij --session "${sessionName}" action ${action}`;
    await runAsUserAsync(cmd, {
      asUser,
      timeout: ZELLIJ_COMMAND_TIMEOUT_MS,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const isTimeout = message.includes('ETIMEDOUT');
    if (isTimeout) {
      console.warn(
        `⚠️ [Zellij] Timeout running action on ${sessionName}: ${action} - Zellij may be stuck`
      );
    } else {
      console.warn(`⚠️ Failed to run Zellij action on ${sessionName}: ${action}\n${message}`);
    }
    if (throwOnError) {
      throw error;
    }
  }
}

/**
 * Cache for Zellij session state (existence and tabs) to avoid repeated expensive queries
 */
class ZellijSessionCache {
  private tabsCache = new Map<string, { tabs: string[]; timestamp: number }>();
  private existsCache = new Map<string, { exists: boolean; timestamp: number }>();

  private getCacheKey(sessionName: string, asUser?: string): string {
    return `${sessionName}:${asUser || 'daemon'}`;
  }

  /**
   * Check if session exists (cached)
   */
  async sessionExists(sessionName: string, asUser?: string): Promise<boolean> {
    const cacheKey = this.getCacheKey(sessionName, asUser);
    const cached = this.existsCache.get(cacheKey);
    const now = Date.now();

    if (cached && now - cached.timestamp < TAB_CACHE_TTL_MS) {
      return cached.exists;
    }

    const exists = await zellijSessionExistsAsync(sessionName, asUser);
    this.existsCache.set(cacheKey, { exists, timestamp: now });
    return exists;
  }

  /**
   * Get cached tabs or fetch fresh if stale
   */
  async getTabs(sessionName: string, asUser?: string): Promise<string[]> {
    const cacheKey = this.getCacheKey(sessionName, asUser);
    const cached = this.tabsCache.get(cacheKey);
    const now = Date.now();

    if (cached && now - cached.timestamp < TAB_CACHE_TTL_MS) {
      return cached.tabs;
    }

    const tabs = await this.fetchTabs(sessionName, asUser);
    this.tabsCache.set(cacheKey, { tabs, timestamp: now });
    return tabs;
  }

  /**
   * Invalidate all caches for a session (call after creating/renaming tabs)
   */
  invalidate(sessionName: string, asUser?: string): void {
    const cacheKey = this.getCacheKey(sessionName, asUser);
    this.tabsCache.delete(cacheKey);
    this.existsCache.delete(cacheKey);
  }

  /**
   * Fetch tabs from Zellij using query-tab-names (fast) instead of dump-layout (slow)
   */
  private async fetchTabs(sessionName: string, asUser?: string): Promise<string[]> {
    try {
      // Use query-tab-names which is much faster than dump-layout
      // query-tab-names returns one tab name per line
      const cmd = `zellij --session "${sessionName}" action query-tab-names 2>/dev/null`;
      const output = await runAsUserAsync(cmd, {
        asUser,
        timeout: ZELLIJ_COMMAND_TIMEOUT_MS,
      });

      // Parse output - one tab name per line
      const tabs = output
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0);

      return tabs;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const isTimeout = message.includes('ETIMEDOUT');
      if (isTimeout) {
        console.warn(
          `[Zellij] Timeout getting tabs for session ${sessionName} - Zellij may be stuck`
        );
      }
      return [];
    }
  }
}

/**
 * Build shell initialization commands for a Zellij tab
 * Sources env file and changes to working directory
 */
function buildInitCommands(envFile: string | null, cwd: string, alwaysCd = false): string[] {
  const commands: string[] = [];

  if (envFile) {
    commands.push(
      `[ -f ${escapeShellArg(envFile)} ] && source ${escapeShellArg(envFile)} 2>/dev/null || true`
    );
  }

  if (alwaysCd || cwd !== os.homedir()) {
    commands.push(`cd ${escapeShellArg(cwd)}`);
  }

  return commands;
}

/**
 * Execute init commands in a Zellij session via write-chars
 */
async function executeInitCommands(
  zellijSession: string,
  initCommands: string[],
  asUser?: string
): Promise<void> {
  if (initCommands.length === 0) return;

  const initScript = initCommands.join(' && ');
  await runZellijActionAsync(
    zellijSession,
    `write-chars "${escapeDoubleQuoted(initScript)}"`,
    asUser
  );
  await runZellijActionAsync(zellijSession, 'write 10', asUser);
}

/**
 * Batches PTY output data to reduce WebSocket message overhead
 * Instead of emitting every byte immediately, buffers for DATA_BATCH_INTERVAL_MS
 * Also enforces MAX_BUFFER_SIZE to prevent unbounded memory growth
 */
class TerminalDataBatcher {
  private buffer = '';
  private timer: NodeJS.Timeout | null = null;
  private onFlush: (data: string) => void;

  constructor(onFlush: (data: string) => void) {
    this.onFlush = onFlush;
  }

  /**
   * Add data to the buffer
   * Will force flush if buffer exceeds MAX_BUFFER_SIZE
   */
  push(data: string): void {
    this.buffer += data;

    // Force flush if buffer is too large (prevents unbounded memory growth)
    if (this.buffer.length >= MAX_BUFFER_SIZE) {
      this.flush();
      return;
    }

    // If no timer running, start one
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.flush();
      }, DATA_BATCH_INTERVAL_MS);
    }
  }

  /**
   * Force flush any buffered data immediately
   */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    if (this.buffer.length > 0) {
      const data = this.buffer;
      this.buffer = '';
      this.onFlush(data);
    }
  }

  /**
   * Clean up resources
   */
  destroy(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.buffer = '';
  }
}

/**
 * Write user environment variables to a shell script
 * This allows shells spawned in Zellij tabs to source the env vars
 *
 * @param userId - User ID for naming the file
 * @param env - Environment variables to export
 * @param chownTo - Optional Unix username to chown the file to (for impersonation)
 * @returns Path to the env file, or null on error
 */
function writeEnvFile(
  userId: UserID | undefined,
  env: Record<string, string>,
  chownTo?: string | null
): string | null {
  if (!userId) return null;

  try {
    const tmpDir = os.tmpdir();
    const envFile = path.join(tmpDir, `agor-env-${userId.substring(0, 8)}.sh`);

    // Build shell script to export env vars
    const exportLines = Object.entries(env)
      .filter(([key]) => {
        // Skip system/shell env vars that shouldn't be overridden
        const skipKeys = ['PATH', 'HOME', 'USER', 'SHELL', 'PWD', 'OLDPWD', 'TERM', 'COLORTERM'];
        return !skipKeys.includes(key);
      })
      .map(([key, value]) => {
        // Escape single quotes in value
        const escapedValue = value.replace(/'/g, "'\\''");
        return `export ${key}='${escapedValue}'`;
      });

    const scriptContent = `#!/bin/sh
# Agor user environment variables
# Auto-generated - do not edit manually
${exportLines.join('\n')}
`;

    // Write file with restrictive permissions initially
    fs.writeFileSync(envFile, scriptContent, { mode: 0o600 });

    // If we're impersonating a user, chown the file to them so they can read it
    // Without this, impersonated users can't source the env file (permission denied)
    if (chownTo) {
      try {
        // CRITICAL: Use -n flag to prevent password prompts that freeze the system
        // Also add timeout to prevent any hangs
        execSync(`sudo -n chown "${chownTo}" "${envFile}"`, { stdio: 'pipe', timeout: 2000 });
      } catch (chownError) {
        console.warn(`Failed to chown env file to ${chownTo}:`, chownError);
        // Continue anyway - file may still be readable in some configurations
      }
    }

    return envFile;
  } catch (error) {
    console.warn('Failed to write user env file:', error);
    return null;
  }
}

/**
 * Terminals service - manages Zellij sessions
 */
export class TerminalsService {
  private sessions = new Map<string, TerminalSession>();
  private app: Application;
  private db: Database;
  private zellijCache = new ZellijSessionCache();

  constructor(app: Application, db: Database) {
    this.app = app;
    this.db = db;

    // Verify Zellij is available - fail hard if not
    if (!isZellijAvailable()) {
      throw new Error(
        '❌ Zellij is not installed or not available in PATH.\n' +
          'Agor requires Zellij for terminal management.\n' +
          'Please install Zellij:\n' +
          '  - Ubuntu/Debian: curl -L https://github.com/zellij-org/zellij/releases/latest/download/zellij-x86_64-unknown-linux-musl.tar.gz | tar -xz -C /usr/local/bin\n' +
          '  - macOS: brew install zellij\n' +
          '  - See: https://zellij.dev/documentation/installation'
      );
    }

    console.log('\x1b[36m✅ Zellij detected\x1b[0m - persistent terminal sessions enabled');
  }

  /**
   * Create a new terminal session
   */
  async create(
    data: CreateTerminalData,
    params?: AuthenticatedParams
  ): Promise<{
    terminalId: string;
    cwd: string;
    zellijSession: string;
    zellijReused: boolean;
    worktreeName?: string;
  }> {
    const terminalId = `term-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const authenticatedUserId = params?.user?.user_id as UserID | undefined;
    const resolvedUserId = data.userId ?? authenticatedUserId;

    const userSessionSuffix = (() => {
      if (!resolvedUserId) return 'shared';
      // Use short ID (8 chars) to keep Zellij session names under length limit
      return formatShortId(resolvedUserId);
    })();

    // =========================================================================
    // DETERMINE UNIX USER IMPERSONATION FIRST
    // This affects how we check Zellij sessions and what cwd to use
    // =========================================================================

    // Determine which Unix user to run the terminal as based on unix_user_mode
    const config = await loadConfig();
    const unixUserMode = config.execution?.unix_user_mode ?? 'simple';
    const executorUser = config.execution?.executor_unix_user;

    let impersonatedUser: string | null = null;

    // Get authenticated user's unix_username if available
    if (authenticatedUserId) {
      const usersRepo = new UsersRepository(this.db);
      try {
        const user = await usersRepo.findById(authenticatedUserId);
        if (user?.unix_username) {
          impersonatedUser = user.unix_username;
        }
      } catch (error) {
        console.warn(`⚠️ Failed to load user ${authenticatedUserId}:`, error);
      }
    }

    // Determine final Unix user based on mode using centralized logic
    const impersonationResult = resolveUnixUserForImpersonation({
      mode: unixUserMode as UnixUserMode,
      userUnixUsername: impersonatedUser,
      executorUnixUser: executorUser,
    });

    const finalUnixUser = impersonationResult.unixUser;

    // Validate Unix user exists for modes that require it
    try {
      validateResolvedUnixUser(unixUserMode as UnixUserMode, finalUnixUser);
    } catch (err) {
      if (err instanceof UnixUserNotFoundError) {
        throw new Error(
          `${(err as UnixUserNotFoundError).message}. Ensure the Unix user is created before attempting terminal access.`
        );
      }
      throw err;
    }

    // =========================================================================
    // RESOLVE WORKTREE AND CWD
    // When impersonating, use symlink path: ~/agor/worktrees/<worktree-name>
    // =========================================================================

    // Resolve worktree context if provided
    let worktree = null;
    let cwd = data.cwd || os.homedir();
    let worktreeName: string | undefined;

    if (data.worktreeId) {
      const worktreeRepo = new WorktreeRepository(this.db);
      worktree = await worktreeRepo.findById(data.worktreeId);
      if (worktree) {
        worktreeName = worktree.name;

        // When impersonating a user, prefer symlink path in their home directory
        // This gives a cleaner path: ~/agor/worktrees/<name> instead of ~/.agor/worktrees/...
        // But fallback to real path if symlink doesn't exist (e.g., for shared worktrees
        // where the user has access via others_can but no explicit ownership/symlink)
        if (finalUnixUser && worktree.name) {
          const symlinkPath = `/home/${finalUnixUser}/agor/worktrees/${worktree.name}`;
          cwd = fs.existsSync(symlinkPath) ? symlinkPath : worktree.path;
        } else {
          cwd = worktree.path;
        }
      }
    }

    // =========================================================================
    // ZELLIJ SESSION AND TAB MANAGEMENT (ASYNC)
    // When impersonating, run Zellij commands as that user
    // All Zellij operations are now async to avoid blocking the event loop
    // =========================================================================

    // Use single shared Zellij session with one tab per worktree
    const zellijSession = `agor-${userSessionSuffix}`;
    const asUser = finalUnixUser || undefined;

    // Check session existence using cache (avoids repeated expensive queries)
    const sessionExists = await this.zellijCache.sessionExists(zellijSession, asUser);
    const tabName = worktreeName || 'terminal';
    let zellijReused = false;
    let needsTabCreation = false;
    let needsTabSwitch = false;

    if (sessionExists) {
      // Session exists - check if this worktree has a tab (using cache)
      const existingTabs = await this.zellijCache.getTabs(zellijSession, asUser);
      const tabExists = existingTabs.includes(tabName);

      if (tabExists) {
        zellijReused = true;
        needsTabSwitch = true;
      } else {
        needsTabCreation = true;
      }
    }

    // =========================================================================
    // ENVIRONMENT SETUP
    // =========================================================================

    // Get user-specific environment variables (for env file)
    const userEnv = resolvedUserId ? await resolveUserEnvironment(resolvedUserId, this.db) : {};

    // Create clean environment for terminal (filters Agor-internal vars, adds user vars)
    const baseEnv = await createUserProcessEnvironment(resolvedUserId, this.db, {
      // Terminal-specific environment defaults
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      LANG: 'C.UTF-8',
    });

    // Strip Zellij env vars to prevent nested sessions
    delete baseEnv.ZELLIJ;
    delete baseEnv.ZELLIJ_SESSION_NAME;

    // Set LC_ALL and LC_CTYPE based on LANG if not already set
    if (!baseEnv.LC_ALL) {
      baseEnv.LC_ALL = baseEnv.LANG;
    }
    if (!baseEnv.LC_CTYPE) {
      baseEnv.LC_CTYPE = baseEnv.LANG;
    }

    const env = baseEnv;

    // Write user env vars to file for sourcing in new shells (only custom user vars)
    // Pass finalUnixUser so the file is chowned to the impersonated user (they need read access)
    const envFile = resolvedUserId ? writeEnvFile(resolvedUserId, userEnv, finalUnixUser) : null;

    let ptyProcess: pty.IPty;

    // Zellij config is NOT explicitly specified - Zellij uses its standard config search:
    //   1. ~/.config/zellij/config.kdl (for effective user)
    //   2. Built-in defaults if no config exists
    //
    // This allows:
    //   - Admins to configure global defaults by placing config in daemon user's home
    //   - Individual users to customize their experience with their own config
    //   - Session serialization to persist terminal state (useful for worktree persistence)

    // Wrap pty.spawn in try-catch to handle native module errors gracefully
    // node-pty is a native module that can throw synchronously on spawn failure
    try {
      // Build environment - override HOME/USER when impersonating
      const spawnEnv = finalUnixUser
        ? { ...env, HOME: `/home/${finalUnixUser}`, USER: finalUnixUser }
        : env;

      // Build spawn args - handles impersonation via sudo su - when finalUnixUser is set
      // IMPORTANT: When impersonating, env vars must be passed through buildSpawnArgs because
      // sudo su - creates a fresh login shell that ignores the env passed to pty.spawn()
      const zellijArgs = ['attach', zellijSession, '--create'];
      const { cmd, args } = buildSpawnArgs('zellij', zellijArgs, {
        asUser: finalUnixUser || undefined,
        env: finalUnixUser ? spawnEnv : undefined, // Only inject when impersonating
      });

      // When NOT impersonating, pass env to pty.spawn() directly
      // When impersonating, env is already injected into the command by buildSpawnArgs
      ptyProcess = pty.spawn(cmd, args, {
        name: 'xterm-256color',
        cols: data.cols || 80,
        rows: data.rows || 30,
        cwd,
        env: finalUnixUser ? undefined : spawnEnv,
      });
    } catch (spawnError) {
      const errorMsg = spawnError instanceof Error ? spawnError.message : String(spawnError);
      console.error(`❌ [Terminal] Failed to spawn PTY for session ${zellijSession}:`, errorMsg);
      throw new Error(`Failed to create terminal session: ${errorMsg}`);
    }

    // Create batcher for this terminal's PTY output
    // This reduces WebSocket message overhead by batching data every 10ms
    const batcher = new TerminalDataBatcher((batchedData) => {
      try {
        this.app.service('terminals').emit('data', {
          terminalId,
          data: batchedData,
        });
      } catch (error) {
        console.warn(`[Terminal ${terminalId}] Error emitting batched data:`, error);
      }
    });

    // Store session (including env for future tab creation)
    this.sessions.set(terminalId, {
      terminalId,
      pty: ptyProcess,
      shell: 'zellij',
      cwd,
      userId: resolvedUserId,
      worktreeId: data.worktreeId,
      zellijSession,
      cols: data.cols || 80,
      rows: data.rows || 30,
      createdAt: new Date(),
      env,
      batcher,
    });

    // Handle PTY output using batcher
    // Instead of emitting every byte immediately, buffer for 10ms to reduce overhead
    ptyProcess.onData((ptyData) => {
      batcher.push(ptyData);
    });

    // Handle PTY exit
    // IMPORTANT: Wrap in try-catch to prevent unhandled errors from crashing daemon
    ptyProcess.onExit(({ exitCode }) => {
      try {
        // Flush any remaining buffered data before closing
        batcher.flush();
        batcher.destroy();

        console.log(`Terminal ${terminalId} exited with code ${exitCode}`);
        this.sessions.delete(terminalId);
        this.app.service('terminals').emit('exit', {
          terminalId,
          exitCode,
        });
      } catch (error) {
        console.warn(`[Terminal ${terminalId}] Error handling exit:`, error);
        // Still try to clean up session
        batcher.destroy();
        this.sessions.delete(terminalId);
      }
    });

    // =========================================================================
    // WAIT FOR PTY READY, THEN PERFORM TAB MANAGEMENT (ASYNC)
    // Instead of hardcoded setTimeout, wait for first PTY output as ready signal
    // This ensures Zellij is fully initialized before we send commands
    // =========================================================================

    // Create a promise that resolves when we receive first PTY output
    const waitForReady = (): Promise<void> => {
      return new Promise((resolve) => {
        let resolved = false;

        // Set up one-time listener for first data
        const onFirstData = () => {
          if (!resolved) {
            resolved = true;
            resolve();
          }
        };

        // Listen to batcher flush (which happens within 10ms of first data)
        const originalOnFlush = batcher['onFlush'];
        batcher['onFlush'] = (flushData: string) => {
          onFirstData();
          // Restore original handler and call it
          batcher['onFlush'] = originalOnFlush;
          originalOnFlush(flushData);
        };

        // Fallback timeout in case no data arrives
        setTimeout(() => {
          if (!resolved) {
            resolved = true;
            console.warn(`[Terminal ${terminalId}] Ready timeout after ${READY_TIMEOUT_MS}ms`);
            resolve();
          }
        }, READY_TIMEOUT_MS);
      });
    };

    // Wait for PTY to be ready before performing tab management
    await waitForReady();

    // Perform tab management (all async, no blocking)
    // Escape tab name and cwd to prevent shell injection from worktree names/paths
    const escapedTabName = escapeDoubleQuoted(tabName);
    const escapedCwd = escapeDoubleQuoted(cwd);

    try {
      if (!sessionExists) {
        // First time creating session - rename first tab and set up environment
        // Use throwOnError=true for critical tab operations so failures propagate
        await runZellijActionAsync(zellijSession, `rename-tab "${escapedTabName}"`, asUser, true);
        this.zellijCache.invalidate(zellijSession, asUser);

        const initCommands = buildInitCommands(envFile, cwd);
        await executeInitCommands(zellijSession, initCommands, asUser);
      } else if (needsTabCreation) {
        // Create new tab for this worktree - critical operations throw on error
        await runZellijActionAsync(
          zellijSession,
          `new-tab --name "${escapedTabName}" --cwd "${escapedCwd}"`,
          asUser,
          true
        );
        await runZellijActionAsync(
          zellijSession,
          `go-to-tab-name "${escapedTabName}"`,
          asUser,
          true
        );
        this.zellijCache.invalidate(zellijSession, asUser);

        // Small delay for tab shell to initialize
        await new Promise((r) => setTimeout(r, 50));

        const initCommands = buildInitCommands(envFile, cwd, true); // alwaysCd=true
        await executeInitCommands(zellijSession, initCommands, asUser);
      } else if (needsTabSwitch) {
        // Switch to existing tab - critical operation throws on error
        await runZellijActionAsync(
          zellijSession,
          `go-to-tab-name "${escapedTabName}"`,
          asUser,
          true
        );

        // Send Ctrl+C to clear any incomplete command, then navigate (non-critical)
        await runZellijActionAsync(zellijSession, 'write 3', asUser);
        await new Promise((r) => setTimeout(r, 20));

        const initCommands = buildInitCommands(envFile, cwd, true); // alwaysCd=true
        await executeInitCommands(zellijSession, initCommands, asUser);
      }
    } catch (error) {
      // Log and re-throw so create() fails and UI can handle/retry
      console.error('Failed to configure Zellij tab:', error);
      throw new Error(
        `Zellij tab configuration failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    return { terminalId, cwd, zellijSession, zellijReused, worktreeName };
  }

  /**
   * Get terminal session info
   */
  async get(id: string): Promise<{ terminalId: string; cwd: string; alive: boolean }> {
    const session = this.sessions.get(id);
    if (!session) {
      throw new Error(`Terminal ${id} not found`);
    }

    return {
      terminalId: session.terminalId,
      cwd: session.cwd,
      alive: true, // PTY doesn't expose exitCode directly
    };
  }

  /**
   * List all terminal sessions
   */
  async find(): Promise<Array<{ terminalId: string; cwd: string; createdAt: Date }>> {
    return Array.from(this.sessions.values()).map((session) => ({
      terminalId: session.terminalId,
      cwd: session.cwd,
      createdAt: session.createdAt,
    }));
  }

  /**
   * Send input to terminal
   */
  async patch(id: string, data: { input?: string; resize?: ResizeTerminalData }): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) {
      throw new Error(`Terminal ${id} not found`);
    }

    if (data.input !== undefined) {
      // Write input to PTY
      session.pty.write(data.input);
    }

    if (data.resize) {
      // Update stored dimensions
      session.cols = data.resize.cols;
      session.rows = data.resize.rows;

      // Resize PTY (this sends SIGWINCH to Zellij)
      session.pty.resize(data.resize.cols, data.resize.rows);
    }
  }

  /**
   * Kill terminal session
   */
  async remove(id: string): Promise<{ terminalId: string }> {
    const session = this.sessions.get(id);
    if (!session) {
      throw new Error(`Terminal ${id} not found`);
    }

    // Flush and destroy batcher before killing PTY
    session.batcher.flush();
    session.batcher.destroy();

    // Kill the PTY process
    session.pty.kill('SIGTERM');
    this.sessions.delete(id);

    return { terminalId: id };
  }

  /**
   * Cleanup all terminals on shutdown
   */
  cleanup(): void {
    for (const session of this.sessions.values()) {
      // Flush and destroy batchers before killing PTYs
      session.batcher.flush();
      session.batcher.destroy();
      session.pty.kill('SIGTERM');
    }
    this.sessions.clear();
  }
}
