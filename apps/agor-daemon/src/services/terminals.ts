/**
 * Terminals Service
 *
 * Manages Zellij-based terminal sessions via executor processes.
 * REQUIRES Zellij to be installed on the system.
 *
 * Features:
 * - Full terminal emulation (vim, nano, htop, etc.)
 * - Job control (Ctrl+C, Ctrl+Z)
 * - ANSI colors and escape codes
 * - Persistent sessions via Zellij (survive daemon restarts)
 * - One executor per user, one Zellij tab per worktree
 *
 * Architecture:
 * - Executor process owns PTY running `zellij attach`
 * - PTY I/O streams over Feathers channels: user/${userId}/terminal
 * - Zellij handles session/tab multiplexing
 * - xterm.js frontend for rendering
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createUserProcessEnvironment,
  loadConfig,
  resolveUserEnvironment,
} from '@agor/core/config';
import { type Database, formatShortId, UsersRepository, WorktreeRepository } from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import type { AuthenticatedParams, UserID, WorktreeID } from '@agor/core/types';
import {
  resolveUnixUserForImpersonation,
  type UnixUserMode,
  UnixUserNotFoundError,
  validateResolvedUnixUser,
} from '@agor/core/unix';
import { generateSessionToken, spawnExecutorFireAndForget } from '../utils/spawn-executor.js';

interface CreateTerminalData {
  rows?: number;
  cols?: number;
  worktreeId?: WorktreeID; // Worktree context for Zellij integration
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

/** Module-level flag tracking if Zellij warning has been shown */
let zellijWarningShown = false;

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
 * Terminals service - manages Zellij sessions via executor
 *
 * Architecture:
 * - One executor per user (spawned when user opens first terminal)
 * - Executor owns a single PTY running `zellij attach`
 * - Zellij manages multiple tabs (one per worktree)
 * - PTY I/O streams over Feathers channel: user/${userId}/terminal
 */
export class TerminalsService {
  private app: Application;
  private db: Database;

  /** Whether Zellij is available on this system */
  private zellijAvailable: boolean;

  constructor(app: Application, db: Database) {
    this.app = app;
    this.db = db;

    // Check if Zellij is available - warn but don't fail
    this.zellijAvailable = isZellijAvailable();

    if (!this.zellijAvailable) {
      if (!zellijWarningShown) {
        console.warn(
          '\x1b[33m⚠️  Zellij is not installed or not available in PATH.\x1b[0m\n' +
            'Terminal functionality will be unavailable.\n' +
            'To enable terminals, install Zellij:\n' +
            '  - Ubuntu/Debian: curl -L https://github.com/zellij-org/zellij/releases/latest/download/zellij-x86_64-unknown-linux-musl.tar.gz | tar -xz -C /usr/local/bin\n' +
            '  - macOS: brew install zellij\n' +
            '  - See: https://zellij.dev/documentation/installation'
        );
        zellijWarningShown = true;
      }
    } else {
      console.log('\x1b[36m✅ Zellij detected\x1b[0m - persistent terminal sessions enabled');
    }
  }

  /**
   * Create a new terminal session
   *
   * Spawns an executor with Zellij for persistent terminal sessions.
   * One executor per user, one Zellij tab per worktree.
   */
  async create(
    data: CreateTerminalData,
    params?: AuthenticatedParams
  ): Promise<{
    userId: UserID;
    channel: string;
    sessionName: string;
    isNew: boolean;
    worktreeName?: string;
  }> {
    // Check if Zellij is available
    if (!this.zellijAvailable) {
      throw new Error(
        'Terminal functionality is unavailable: Zellij is not installed.\n' +
          'Please install Zellij to enable terminal support.'
      );
    }

    return this.createExecutorTerminal(
      {
        worktreeId: data.worktreeId,
        cols: data.cols,
        rows: data.rows,
      },
      params
    );
  }

  /**
   * Cleanup all terminals on shutdown
   */
  cleanup(): void {
    this.cleanupExecutorTerminals();
  }

  /**
   * Active executor processes per user
   * Key: userId, Value: { process pid, sessionName, worktrees }
   */
  private executorTerminals: Map<
    UserID,
    {
      sessionName: string;
      activeWorktrees: Set<WorktreeID | 'default'>;
      startedAt: Date;
    }
  > = new Map();

  /**
   * Create or join an executor-based terminal session
   *
   * - Spawns one executor per user (not per terminal)
   * - Uses Feathers channels for I/O
   * - Returns immediately (fire-and-forget spawn)
   *
   * The browser should join the user's terminal channel to receive output.
   */
  private async createExecutorTerminal(
    data: {
      worktreeId?: WorktreeID;
      cols?: number;
      rows?: number;
    },
    params?: AuthenticatedParams
  ): Promise<{
    userId: UserID;
    channel: string;
    sessionName: string;
    isNew: boolean;
    worktreeName?: string;
  }> {
    const userId = params?.user?.user_id as UserID;
    if (!userId) {
      throw new Error('Authentication required for executor terminal');
    }

    // Check if user already has an executor running
    const existing = this.executorTerminals.get(userId);
    if (existing) {
      // Add worktree to active set
      const worktreeKey = data.worktreeId || 'default';
      existing.activeWorktrees.add(worktreeKey);

      // If worktree specified, tell executor to create/focus tab
      if (data.worktreeId) {
        const worktreeRepo = new WorktreeRepository(this.db);
        const worktree = await worktreeRepo.findById(data.worktreeId);
        if (worktree) {
          // Emit tab command via channel - executor will handle it
          this.app.io?.to(`user/${userId}/terminal`).emit('terminal:tab', {
            userId,
            action: 'create',
            tabName: worktree.name,
            cwd: worktree.path,
          });

          // Request screen redraw after a short delay to let client join channel first
          setTimeout(() => {
            this.app.io?.to(`user/${userId}/terminal`).emit('terminal:redraw', { userId });
          }, 200);

          return {
            userId,
            channel: `user/${userId}/terminal`,
            sessionName: existing.sessionName,
            isNew: false,
            worktreeName: worktree.name,
          };
        }
      }

      // Request screen redraw after a short delay to let client join channel first
      setTimeout(() => {
        this.app.io?.to(`user/${userId}/terminal`).emit('terminal:redraw', { userId });
      }, 200);

      return {
        userId,
        channel: `user/${userId}/terminal`,
        sessionName: existing.sessionName,
        isNew: false,
      };
    }

    // Resolve Unix user for impersonation
    const config = await loadConfig();
    const unixUserMode = config.execution?.unix_user_mode ?? 'simple';
    const executorUser = config.execution?.executor_unix_user;

    let impersonatedUser: string | null = null;
    const usersRepo = new UsersRepository(this.db);
    try {
      const user = await usersRepo.findById(userId);
      if (user?.unix_username) {
        impersonatedUser = user.unix_username;
      }
    } catch (error) {
      console.warn(`⚠️ Failed to load user ${userId}:`, error);
    }

    const impersonationResult = resolveUnixUserForImpersonation({
      mode: unixUserMode as UnixUserMode,
      userUnixUsername: impersonatedUser,
      executorUnixUser: executorUser,
    });

    const finalUnixUser = impersonationResult.unixUser;

    // Validate Unix user exists
    try {
      validateResolvedUnixUser(unixUserMode as UnixUserMode, finalUnixUser);
    } catch (err) {
      if (err instanceof UnixUserNotFoundError) {
        throw new Error(`${(err as UnixUserNotFoundError).message}`);
      }
      throw err;
    }

    // Determine cwd and worktree info
    let cwd = os.homedir();
    let worktreeName: string | undefined;

    if (data.worktreeId) {
      const worktreeRepo = new WorktreeRepository(this.db);
      const worktree = await worktreeRepo.findById(data.worktreeId);
      if (worktree) {
        worktreeName = worktree.name;
        if (finalUnixUser) {
          const symlinkPath = `/home/${finalUnixUser}/agor/worktrees/${worktree.name}`;
          cwd = fs.existsSync(symlinkPath) ? symlinkPath : worktree.path;
        } else {
          cwd = worktree.path;
        }
      }
    }

    // Build Zellij session name
    const userSessionSuffix = formatShortId(userId);
    const sessionName = `agor-${userSessionSuffix}`;

    // Generate session token for executor
    const daemonUrl = `http://localhost:${config.daemon?.port || 3030}`;
    const sessionToken = generateSessionToken(this.app);

    // Get user environment and write env file for shell sourcing
    const userEnv = await resolveUserEnvironment(userId, this.db);
    const envFile = writeEnvFile(userId, userEnv, finalUnixUser);

    // Get executor process environment (includes system vars)
    const executorEnv = await createUserProcessEnvironment(userId, this.db);

    // Spawn executor with zellij.attach command
    spawnExecutorFireAndForget(
      {
        command: 'zellij.attach',
        sessionToken,
        daemonUrl,
        params: {
          userId,
          sessionName,
          cwd,
          tabName: worktreeName,
          cols: data.cols || 160,
          rows: data.rows || 40,
          envFile, // Pass env file path for shell to source
        },
      },
      {
        logPrefix: `[TerminalsService.executor ${userId.slice(0, 8)}]`,
        asUser: finalUnixUser || undefined,
        env: executorEnv,
        // Clean up map when executor exits (handles crashes too)
        onExit: () => this.handleExecutorExit(userId),
      }
    );

    // Track the executor
    this.executorTerminals.set(userId, {
      sessionName,
      activeWorktrees: new Set([data.worktreeId || 'default']),
      startedAt: new Date(),
    });

    return {
      userId,
      channel: `user/${userId}/terminal`,
      sessionName,
      isNew: true,
      worktreeName,
    };
  }

  /**
   * Close executor terminal for a worktree
   *
   * If this is the last active worktree, the executor will exit naturally
   * when the user detaches from Zellij.
   */
  async closeExecutorTerminal(
    data: { worktreeId?: WorktreeID },
    params?: AuthenticatedParams
  ): Promise<{ closed: boolean }> {
    const userId = params?.user?.user_id as UserID;
    if (!userId) {
      throw new Error('Authentication required');
    }

    const executor = this.executorTerminals.get(userId);
    if (!executor) {
      return { closed: false };
    }

    const worktreeKey = data.worktreeId || 'default';
    executor.activeWorktrees.delete(worktreeKey);

    // If no more active worktrees, mark executor for cleanup
    // The executor will exit when Zellij detaches
    if (executor.activeWorktrees.size === 0) {
      this.executorTerminals.delete(userId);
    }

    return { closed: true };
  }

  /**
   * Cleanup executor terminals (called on daemon shutdown)
   */
  private cleanupExecutorTerminals(): void {
    // Executors manage their own lifecycle via Zellij
    // Just clear our tracking
    this.executorTerminals.clear();
  }

  /**
   * Handle executor terminal exit (called from channel event)
   */
  handleExecutorExit(userId: UserID): void {
    this.executorTerminals.delete(userId);
    console.log(`[TerminalsService] Executor terminal exited for user ${userId.slice(0, 8)}`);
  }
}
