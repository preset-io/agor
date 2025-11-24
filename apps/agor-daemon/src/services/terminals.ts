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
import { createUserProcessEnvironment, loadConfig } from '@agor/core/config';
import { type Database, formatShortId, WorktreeRepository } from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import type { AuthenticatedParams, UserID, WorktreeID } from '@agor/core/types';
import * as pty from '@homebridge/node-pty-prebuilt-multiarch';

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
 * Check if Zellij is installed
 */
function isZellijAvailable(): boolean {
  try {
    execSync('which zellij', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Write user environment variables to a shell script
 * This allows shells spawned in Zellij tabs to source the env vars
 */
function writeEnvFile(userId: UserID | undefined, env: Record<string, string>): string | null {
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

    fs.writeFileSync(envFile, scriptContent, { mode: 0o600 });
    return envFile;
  } catch (error) {
    console.warn('Failed to write user env file:', error);
    return null;
  }
}

/**
 * Check if a Zellij session exists
 */
function zellijSessionExists(sessionName: string): boolean {
  try {
    const output = execSync('zellij list-sessions 2>/dev/null', {
      encoding: 'utf-8',
      stdio: 'pipe',
    });
    return output.includes(sessionName);
  } catch {
    return false;
  }
}

/**
 * Run a Zellij CLI action on a specific session
 */
function runZellijAction(sessionName: string, action: string): void {
  try {
    execSync(`zellij --session "${sessionName}" action ${action}`, { stdio: 'pipe' });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`⚠️ Failed to run Zellij action on ${sessionName}: ${action}\n${message}`);
  }
}

/**
 * Get list of tab names in a Zellij session
 * Returns array of tab names, or empty array if session doesn't exist
 */
function getZellijTabs(sessionName: string): string[] {
  try {
    // Use zellij action to dump layout, then parse tab names
    // This is hacky but works - alternative is to maintain our own state
    const output = execSync(`zellij --session "${sessionName}" action dump-layout 2>/dev/null`, {
      encoding: 'utf-8',
      stdio: 'pipe',
    });

    // Parse tab names from layout dump (this is brittle, but functional)
    // Layout format includes: name: "tab-name"
    const tabMatches = output.matchAll(/name:\s*"([^"]+)"/g);
    const tabs: string[] = [];
    for (const match of tabMatches) {
      if (match[1]) tabs.push(match[1]);
    }
    return tabs;
  } catch {
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
    const userSessionSuffix = (() => {
      if (!resolvedUserId) return 'shared';
      // Use short ID (8 chars) to keep Zellij session names under length limit
      return formatShortId(resolvedUserId);
    })();

    // Resolve worktree context if provided
    let worktree = null;
    let cwd = data.cwd || os.homedir();
    let worktreeName: string | undefined;

    if (data.worktreeId) {
      const worktreeRepo = new WorktreeRepository(this.db);
      worktree = await worktreeRepo.findById(data.worktreeId);
      if (worktree) {
        cwd = worktree.path;
        worktreeName = worktree.name;
      }
    }

    // Use single shared Zellij session with one tab per worktree
    const zellijSession = `agor-${userSessionSuffix}`;
    const sessionExists = zellijSessionExists(zellijSession);
    const tabName = worktreeName || 'terminal';
    let zellijReused = false;
    let needsTabCreation = false;
    let needsTabSwitch = false;

    if (sessionExists) {
      // Session exists - check if this worktree has a tab
      const existingTabs = getZellijTabs(zellijSession);
      const tabExists = existingTabs.includes(tabName);

      if (tabExists) {
        // Tab exists - we'll switch to it after attach
        zellijReused = true;
        needsTabSwitch = true;
        console.log(`\x1b[36m🔗 Reusing Zellij tab:\x1b[0m ${zellijSession} → ${tabName}`);
      } else {
        // Tab doesn't exist - we'll create it after attach
        needsTabCreation = true;
        console.log(`\x1b[36m📑 Creating new tab in Zellij:\x1b[0m ${zellijSession} → ${tabName}`);
      }
    } else {
      // Session doesn't exist - will be created with first tab
      console.log(
        `\x1b[36m🚀 Creating Zellij session:\x1b[0m ${zellijSession} with tab ${tabName}`
      );
    }

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

    // Write user env vars to file for sourcing in new shells
    // Note: writeEnvFile gets only the user-specific vars, not the full env
    // This is OK - writeEnvFile filters out system vars anyway
    const envFile = resolvedUserId ? writeEnvFile(resolvedUserId, env) : null;
    if (envFile && resolvedUserId) {
      console.log(
        `📝 Wrote user env file: ${envFile} (for user ${resolvedUserId.substring(0, 8)})`
      );
    }

    // Check if executor impersonation is configured
    const config = await loadConfig();
    const executorUser = config.execution?.executor_unix_user;

    let ptyProcess: pty.IPty;

    if (executorUser) {
      // Executor impersonation enabled - run Zellij as executor user via sudo
      const executorHome = `/home/${executorUser}`;
      const configPath = path.join(executorHome, '.config', 'zellij', 'config.kdl');

      console.log(`🔐 Running terminal as executor user: ${executorUser} (impersonation enabled)`);

      const sudoArgs = [
        '-u',
        executorUser,
        'zellij',
        '--config',
        configPath,
        'attach',
        zellijSession,
        '--create',
      ];

      ptyProcess = pty.spawn('sudo', sudoArgs, {
        name: 'xterm-256color',
        cols: data.cols || 80,
        rows: data.rows || 30,
        cwd,
        env: {
          ...env,
          HOME: executorHome,
          USER: executorUser,
        },
      });
    } else {
      // No executor impersonation - run Zellij as daemon user
      const configPath = path.join(os.homedir(), '.config', 'zellij', 'config.kdl');

      console.log(`🔓 Running terminal as daemon user (no impersonation)`);

      const zellijArgs = ['--config', configPath, 'attach', zellijSession, '--create'];

      ptyProcess = pty.spawn('zellij', zellijArgs, {
        name: 'xterm-256color',
        cols: data.cols || 80,
        rows: data.rows || 30,
        cwd,
        env,
      });
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
    ptyProcess.onData((data) => {
      this.app.service('terminals').emit('data', {
        terminalId,
        data,
      });
    });

    // Handle PTY exit
    ptyProcess.onExit(({ exitCode }) => {
      console.log(`Terminal ${terminalId} exited with code ${exitCode}`);
      this.sessions.delete(terminalId);
      this.app.service('terminals').emit('exit', {
        terminalId,
        exitCode,
      });
    });

    // After Zellij starts, perform tab management and show welcome message
    // Wait briefly for Zellij to initialize
    setTimeout(() => {
      try {
        if (!sessionExists) {
          // First time creating session - rename first tab
          runZellijAction(zellijSession, `rename-tab "${tabName}"`);
          // Change to worktree directory
          if (cwd !== os.homedir()) {
            runZellijAction(zellijSession, `write-chars "cd ${cwd}"`);
            runZellijAction(zellijSession, 'write 10'); // Enter key (char code 10)
          }
          // Show welcome message for new session (simplified to reduce blocking)
          // Source user env file if it exists
          if (envFile) {
            runZellijAction(zellijSession, `write-chars "source ${envFile} 2>/dev/null || true"`);
            runZellijAction(zellijSession, 'write 10');
          }
        } else if (needsTabCreation) {
          // Create new tab for this worktree
          runZellijAction(zellijSession, `new-tab --name "${tabName}" --cwd "${cwd}"`);
          runZellijAction(zellijSession, `go-to-tab-name "${tabName}"`);
          // Source user env file in new tab if it exists
          if (envFile) {
            setTimeout(() => {
              runZellijAction(
                zellijSession,
                `write-chars "[ -f ${envFile} ] && source ${envFile}"`
              );
              runZellijAction(zellijSession, 'write 10');
            }, 200);
          }
        } else if (needsTabSwitch) {
          // Switch to existing tab
          runZellijAction(zellijSession, `go-to-tab-name "${tabName}"`);
        }

        // Terminal size is handled by PTY (node-pty sends SIGWINCH to Zellij)
        // No explicit Zellij resize action needed
      } catch (error) {
        console.warn('Failed to configure Zellij tab:', error);
      }
    }, 500);

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
