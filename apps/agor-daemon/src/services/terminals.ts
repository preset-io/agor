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
  buildSpawnArgs,
  resolveUnixUserForImpersonation,
  runAsUser,
  type UnixUserMode,
  UnixUserNotFoundError,
  validateResolvedUnixUser,
} from '@agor/core/unix';
import * as pty from '@homebridge/node-pty-prebuilt-multiarch';

/**
 * Default timeout for Zellij operations in milliseconds
 * 5 seconds is enough for any Zellij command - if it takes longer, something is wrong
 * This prevents the daemon from freezing if Zellij hangs
 */
const ZELLIJ_COMMAND_TIMEOUT_MS = 5000;

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
 * Escape a string for use within double quotes in a Zellij write-chars command
 * Must escape: backslashes, double quotes, dollar signs, backticks
 */
function escapeForWriteChars(str: string): string {
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
 * Check if a Zellij session exists
 *
 * @param sessionName - Zellij session name
 * @param asUser - Optional Unix username to check as (for impersonated sessions)
 *                 Caller must ensure user exists before calling
 */
function zellijSessionExists(sessionName: string, asUser?: string): boolean {
  try {
    console.log(
      `[Zellij] Checking session exists: ${sessionName} (as: ${asUser || 'daemon user'})`
    );
    const output = runAsUser('zellij list-sessions 2>/dev/null', {
      asUser,
      timeout: ZELLIJ_COMMAND_TIMEOUT_MS,
    });
    return output.includes(sessionName);
  } catch (error) {
    // Timeout or other error - assume session doesn't exist
    const isTimeout = error instanceof Error && error.message.includes('ETIMEDOUT');
    if (isTimeout) {
      console.warn(`[Zellij] Timeout checking session ${sessionName} - Zellij may be stuck`);
    }
    return false;
  }
}

/**
 * Run a Zellij CLI action on a specific session
 *
 * @param sessionName - Zellij session name
 * @param action - Zellij action to run
 * @param asUser - Optional Unix username to run as (for impersonated sessions)
 *                 Caller must ensure user exists before calling
 */
function runZellijAction(sessionName: string, action: string, asUser?: string): void {
  try {
    const cmd = `zellij --session "${sessionName}" action ${action}`;
    runAsUser(cmd, {
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
  }
}

/**
 * Get list of tab names in a Zellij session
 * Returns array of tab names, or empty array if session doesn't exist
 *
 * @param sessionName - Zellij session name
 * @param asUser - Optional Unix username to run as (for impersonated sessions)
 *                 Caller must ensure user exists before calling
 */
function getZellijTabs(sessionName: string, asUser?: string): string[] {
  try {
    // Use zellij action to dump layout, then parse tab names
    // This is hacky but works - alternative is to maintain our own state
    const cmd = `zellij --session "${sessionName}" action dump-layout 2>/dev/null`;
    const output = runAsUser(cmd, {
      asUser,
      timeout: ZELLIJ_COMMAND_TIMEOUT_MS,
    });

    // Parse tab names from layout dump (this is brittle, but functional)
    // Layout format includes: name: "tab-name"
    const tabMatches = output.matchAll(/name:\s*"([^"]+)"/g);
    const tabs: string[] = [];
    for (const match of tabMatches) {
      if (match[1]) tabs.push(match[1]);
    }

    // Debug logging to help diagnose tab detection issues
    if (tabs.length > 0) {
      console.log(`[Zellij] Found ${tabs.length} tabs in session ${sessionName}:`, tabs);
    }

    return tabs;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const isTimeout = message.includes('ETIMEDOUT');
    if (isTimeout) {
      console.warn(
        `[Zellij] Timeout getting tabs for session ${sessionName} - Zellij may be stuck`
      );
    } else {
      console.warn(`[Zellij] Failed to get tabs for session ${sessionName}:`, error);
    }
    return [];
  }
}

/**
 * Terminals service - manages Zellij sessions
 */
export class TerminalsService {
  private sessions = new Map<string, TerminalSession>();
  private app: Application;
  private db: Database;

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

    console.log(
      `🔍 Terminal create - authenticatedUserId: ${authenticatedUserId}, resolvedUserId: ${resolvedUserId}, params:`,
      params
    );

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
        console.log(`🔍 Loaded user for impersonation:`, {
          userId: authenticatedUserId,
          user,
          unix_username: user?.unix_username,
        });
        if (user?.unix_username) {
          impersonatedUser = user.unix_username;
        }
      } catch (error) {
        console.warn(`⚠️ Failed to load user ${authenticatedUserId}:`, error);
      }
    } else {
      console.log(`🔍 No authenticatedUserId for impersonation check`);
    }

    // Determine final Unix user based on mode using centralized logic
    const impersonationResult = resolveUnixUserForImpersonation({
      mode: unixUserMode as UnixUserMode,
      userUnixUsername: impersonatedUser,
      executorUnixUser: executorUser,
    });

    const finalUnixUser = impersonationResult.unixUser;
    const impersonationReason = impersonationResult.reason;

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
          if (fs.existsSync(symlinkPath)) {
            cwd = symlinkPath;
            console.log(`📂 Using symlink path for cwd: ${cwd}`);
          } else {
            cwd = worktree.path;
            console.log(`📂 Symlink not found, using real path for cwd: ${cwd}`);
          }
        } else {
          cwd = worktree.path;
        }
      }
    }

    // =========================================================================
    // ZELLIJ SESSION AND TAB MANAGEMENT
    // When impersonating, run Zellij commands as that user
    // =========================================================================

    // Use single shared Zellij session with one tab per worktree
    const zellijSession = `agor-${userSessionSuffix}`;
    // Pass finalUnixUser to check sessions owned by that user (or undefined for daemon user)
    const sessionExists = zellijSessionExists(zellijSession, finalUnixUser || undefined);
    const tabName = worktreeName || 'terminal';
    let zellijReused = false;
    let needsTabCreation = false;
    let needsTabSwitch = false;

    if (sessionExists) {
      // Session exists - check if this worktree has a tab
      const existingTabs = getZellijTabs(zellijSession, finalUnixUser || undefined);
      console.log(
        `[Zellij] Session ${zellijSession} exists with ${existingTabs.length} tabs. Looking for tab: "${tabName}"`
      );
      const tabExists = existingTabs.includes(tabName);

      if (tabExists) {
        // Tab exists - we'll switch to it after attach
        zellijReused = true;
        needsTabSwitch = true;
        console.log(
          `\x1b[36m🔗 Reusing Zellij tab:\x1b[0m ${zellijSession} → ${tabName} (tab found in existing tabs)`
        );
      } else {
        // Tab doesn't exist - we'll create it after attach
        needsTabCreation = true;
        console.log(
          `\x1b[36m📑 Creating new tab in Zellij:\x1b[0m ${zellijSession} → ${tabName} (tab not found in [${existingTabs.join(', ')}])`
        );
      }
    } else {
      // Session doesn't exist - will be created with first tab
      console.log(
        `\x1b[36m🚀 Creating Zellij session:\x1b[0m ${zellijSession} with tab ${tabName}`
      );
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
    if (envFile && resolvedUserId) {
      console.log(
        `📝 Wrote user env file: ${envFile} (${Object.keys(userEnv).length} custom vars for user ${resolvedUserId.substring(0, 8)}${finalUnixUser ? `, chowned to ${finalUnixUser}` : ''})`
      );
    }

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

      // Log impersonation decision
      if (finalUnixUser) {
        console.log(
          `🔐 Running terminal as Unix user: ${finalUnixUser} (${impersonationReason}, ${Object.keys(spawnEnv).length} env vars)`
        );
      } else {
        console.log(`🔓 Running terminal as daemon user (${impersonationReason})`);
      }

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
    });

    // Handle PTY output
    // IMPORTANT: Wrap in try-catch to prevent unhandled errors from crashing daemon
    ptyProcess.onData((data) => {
      try {
        this.app.service('terminals').emit('data', {
          terminalId,
          data,
        });
      } catch (error) {
        console.warn(`[Terminal ${terminalId}] Error emitting data:`, error);
      }
    });

    // Handle PTY exit
    // IMPORTANT: Wrap in try-catch to prevent unhandled errors from crashing daemon
    ptyProcess.onExit(({ exitCode }) => {
      try {
        console.log(`Terminal ${terminalId} exited with code ${exitCode}`);
        this.sessions.delete(terminalId);
        this.app.service('terminals').emit('exit', {
          terminalId,
          exitCode,
        });
      } catch (error) {
        console.warn(`[Terminal ${terminalId}] Error handling exit:`, error);
        // Still try to clean up session
        this.sessions.delete(terminalId);
      }
    });

    // After Zellij starts, perform tab management and show welcome message
    // Capture finalUnixUser for use in setTimeout closures
    const asUser = finalUnixUser || undefined;

    // Wait for Zellij to fully initialize before injecting commands
    // 400ms allows time for terminal capability negotiation (color queries, etc.)
    // to complete before we send write-chars commands
    setTimeout(() => {
      try {
        if (!sessionExists) {
          // First time creating session - rename first tab and set up environment
          runZellijAction(zellijSession, `rename-tab "${tabName}"`, asUser);

          // Build initialization command that sources env and navigates to cwd
          // Use compound command with && to ensure each step succeeds before next
          const initCommands: string[] = [];

          // Source user env file if it exists (silently fail if not)
          if (envFile) {
            initCommands.push(
              `[ -f ${escapeShellArg(envFile)} ] && source ${escapeShellArg(envFile)} 2>/dev/null || true`
            );
          }

          // Navigate to worktree directory if not home
          if (cwd !== os.homedir()) {
            initCommands.push(`cd ${escapeShellArg(cwd)}`);
          }

          // Execute initialization commands
          if (initCommands.length > 0) {
            const initScript = initCommands.join(' && ');
            // Escape the entire script for write-chars (which uses double quotes)
            runZellijAction(
              zellijSession,
              `write-chars "${escapeForWriteChars(initScript)}"`,
              asUser
            );
            runZellijAction(zellijSession, 'write 10', asUser); // Enter key
          }
        } else if (needsTabCreation) {
          // Create new tab for this worktree
          // NOTE: We still pass --cwd to new-tab, but also explicitly cd afterwards
          // This ensures we end up in the right directory even if shell RC files change it
          runZellijAction(zellijSession, `new-tab --name "${tabName}" --cwd "${cwd}"`, asUser);
          runZellijAction(zellijSession, `go-to-tab-name "${tabName}"`, asUser);

          // Wait for tab to be created and shell to initialize
          // Reduced from 300ms to 150ms
          // IMPORTANT: Wrap in try-catch to prevent crashes from nested setTimeout
          setTimeout(() => {
            try {
              // Build initialization command that sources env and navigates to cwd
              const initCommands: string[] = [];

              // Source user env file if it exists (silently fail if not)
              if (envFile) {
                initCommands.push(
                  `[ -f ${escapeShellArg(envFile)} ] && source ${escapeShellArg(envFile)} 2>/dev/null || true`
                );
              }

              // ALWAYS cd to worktree directory to override any shell RC file changes
              // Use single quotes for maximum safety against shell metacharacters
              initCommands.push(`cd ${escapeShellArg(cwd)}`);

              // Execute initialization commands
              if (initCommands.length > 0) {
                const initScript = initCommands.join(' && ');
                // Escape the entire script for write-chars (which uses double quotes)
                runZellijAction(
                  zellijSession,
                  `write-chars "${escapeForWriteChars(initScript)}"`,
                  asUser
                );
                runZellijAction(zellijSession, 'write 10', asUser); // Enter key
              }
            } catch (error) {
              console.warn('[Zellij] Error in tab creation callback:', error);
            }
          }, 150);
        } else if (needsTabSwitch) {
          // Switch to existing tab
          runZellijAction(zellijSession, `go-to-tab-name "${tabName}"`, asUser);

          // Wait briefly for tab switch, then clear any incomplete commands
          // Reduced from 200ms to 100ms
          // IMPORTANT: Wrap in try-catch to prevent crashes from nested setTimeout
          setTimeout(() => {
            try {
              // Send Ctrl+C to clear any incomplete command on the prompt
              // This ensures we start with a clean prompt
              runZellijAction(zellijSession, 'write 3', asUser); // Ctrl+C (char code 3)

              // Wait a bit for Ctrl+C to take effect and show new prompt
              // Reduced from 100ms to 50ms
              // IMPORTANT: Wrap in try-catch to prevent crashes from nested setTimeout
              setTimeout(() => {
                try {
                  // Build initialization command that sources env and navigates to cwd
                  const initCommands: string[] = [];

                  // Source user env file if it exists (refresh environment on reuse)
                  if (envFile) {
                    initCommands.push(
                      `[ -f ${escapeShellArg(envFile)} ] && source ${escapeShellArg(envFile)} 2>/dev/null || true`
                    );
                  }

                  // Navigate to worktree directory to ensure we're in the right place
                  // This handles cases where user cd'd elsewhere in a previous session
                  initCommands.push(`cd ${escapeShellArg(cwd)}`);

                  // Execute initialization commands
                  if (initCommands.length > 0) {
                    const initScript = initCommands.join(' && ');
                    // Escape the entire script for write-chars (which uses double quotes)
                    runZellijAction(
                      zellijSession,
                      `write-chars "${escapeForWriteChars(initScript)}"`,
                      asUser
                    );
                    runZellijAction(zellijSession, 'write 10', asUser); // Enter key
                  }
                } catch (error) {
                  console.warn('[Zellij] Error in tab switch inner callback:', error);
                }
              }, 50);
            } catch (error) {
              console.warn('[Zellij] Error in tab switch callback:', error);
            }
          }, 100);
        }

        // Terminal size is handled by PTY (node-pty sends SIGWINCH to Zellij)
        // No explicit Zellij resize action needed
      } catch (error) {
        console.warn('Failed to configure Zellij tab:', error);
      }
    }, 400);

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
      session.pty.kill('SIGTERM');
    }
    this.sessions.clear();
  }
}
