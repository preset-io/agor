/**
 * Terminals Service
 *
 * Manages tmux-based terminal sessions for web-based terminal access.
 * REQUIRES tmux to be installed on the system.
 *
 * Features:
 * - Full terminal emulation (vim, nano, htop, etc.)
 * - Job control (Ctrl+C, Ctrl+Z)
 * - Terminal resizing
 * - ANSI colors and escape codes
 * - Persistent sessions via tmux
 */

import { execSync } from 'node:child_process';
import os from 'node:os';
import { resolveUserEnvironment } from '@agor/core/config';
import { type Database, WorktreeRepository } from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import type { AuthenticatedParams, UserID, WorktreeID } from '@agor/core/types';
import type { IPty } from '@homebridge/node-pty-prebuilt-multiarch';
import * as pty from '@homebridge/node-pty-prebuilt-multiarch';

interface TerminalSession {
  terminalId: string;
  pty: IPty;
  shell: string;
  cwd: string;
  userId?: UserID; // User context for env resolution
  worktreeId?: WorktreeID; // Worktree context for tmux session naming
  tmuxSession: string; // Tmux session name (always required)
  createdAt: Date;
}

interface CreateTerminalData {
  cwd?: string;
  shell?: string;
  rows?: number;
  cols?: number;
  userId?: UserID; // User context for env resolution
  worktreeId?: WorktreeID; // Worktree context for tmux integration
}

interface ResizeTerminalData {
  rows: number;
  cols: number;
}

/**
 * Check if tmux is installed
 */
function isTmuxAvailable(): boolean {
  try {
    execSync('which tmux', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if a tmux session exists
 */
function tmuxSessionExists(sessionName: string): boolean {
  try {
    execSync(`tmux has-session -t "${sessionName}" 2>/dev/null`, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Find a tmux window by name in a session
 * Returns the window index if found, null otherwise
 */
function findTmuxWindow(sessionName: string, windowName: string): number | null {
  try {
    // List windows in session and grep for the window name
    const output = execSync(
      `tmux list-windows -t "${sessionName}" -F "#{window_index}:#{window_name}" 2>/dev/null`,
      { encoding: 'utf-8' }
    );

    for (const line of output.trim().split('\n')) {
      const [index, name] = line.split(':');
      if (name === windowName) {
        return parseInt(index, 10);
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Ensure tmux session is configured to pass OSC hyperlinks and other rich output.
 */
function configureTmuxSession(sessionName: string): void {
  try {
    execSync(`tmux set-option -t "${sessionName}" -g allow-passthrough on`, { stdio: 'pipe' });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(
      `⚠️ Failed to enable tmux allow-passthrough for session ${sessionName}: ${message}`
    );
  }

  try {
    execSync(`tmux set-option -t "${sessionName}" -g default-terminal 'tmux-256color'`, {
      stdio: 'pipe',
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`⚠️ Failed to set tmux default-terminal for ${sessionName}: ${message}`);
  }

  try {
    execSync(`tmux set-option -ga terminal-features 'xterm*:allow-passthrough'`, { stdio: 'pipe' });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`⚠️ Failed to advertise tmux allow-passthrough feature: ${message}`);
  }

  try {
    execSync(`tmux set-option -ga terminal-features 'tmux-256color:hyperlinks,RGB,extkeys'`, {
      stdio: 'pipe',
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`⚠️ Failed to advertise tmux tmux-256color features: ${message}`);
  }

  try {
    execSync(`tmux set-option -ga terminal-features 'xterm*:hyperlinks'`, { stdio: 'pipe' });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`⚠️ Failed to enable tmux hyperlink feature: ${message}`);
  }

  try {
    execSync(`tmux set-option -as terminal-overrides ',*:allow-passthrough'`, { stdio: 'pipe' });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`⚠️ Failed to configure tmux allow-passthrough override: ${message}`);
  }

  try {
    execSync(`tmux set-option -as terminal-overrides ',*:hyperlinks'`, { stdio: 'pipe' });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`⚠️ Failed to configure tmux hyperlink override: ${message}`);
  }
}

/**
 * Terminals service - manages tmux sessions
 */
export class TerminalsService {
  private sessions = new Map<string, TerminalSession>();
  private app: Application;
  private db: Database;

  constructor(app: Application, db: Database) {
    this.app = app;
    this.db = db;

    // Verify tmux is available - fail hard if not
    if (!isTmuxAvailable()) {
      throw new Error(
        '❌ tmux is not installed or not available in PATH.\n' +
          'Agor requires tmux for terminal management.\n' +
          'Please install tmux:\n' +
          '  - Ubuntu/Debian: sudo apt-get install tmux\n' +
          '  - macOS: brew install tmux\n' +
          '  - RHEL/CentOS: sudo yum install tmux'
      );
    }

    console.log('\x1b[36m✅ tmux detected\x1b[0m - persistent terminal sessions enabled');
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
    tmuxSession: string;
    tmuxReused: boolean;
    worktreeName?: string;
  }> {
    const terminalId = `term-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const authenticatedUserId = params?.user?.user_id as UserID | undefined;
    const resolvedUserId = data.userId ?? authenticatedUserId;
    const userSessionSuffix = (() => {
      if (!resolvedUserId) return 'shared';
      const sanitized = resolvedUserId.replace(/[^a-zA-Z0-9_-]/g, '');
      return sanitized.length > 0 ? sanitized : 'user';
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

    // Use single shared tmux session with one window per worktree
    const tmuxSession = `agor-${userSessionSuffix}`;
    const sessionExists = tmuxSessionExists(tmuxSession);
    const windowName = worktreeName || 'unnamed';
    let tmuxReused = false;
    let shellArgs: string[];

    if (sessionExists) {
      configureTmuxSession(tmuxSession);
      // Session exists - check if this worktree has a window
      const windowIndex = findTmuxWindow(tmuxSession, windowName);

      if (windowIndex !== null) {
        // Window exists - attach and select it
        shellArgs = ['attach-session', '-t', `${tmuxSession}:${windowIndex}`];
        tmuxReused = true;
        console.log(
          `\x1b[36m🔗 Reusing tmux window:\x1b[0m ${tmuxSession}:${windowIndex} (${windowName})`
        );
      } else {
        // Window doesn't exist - attach and create new window
        shellArgs = [
          'attach-session',
          '-t',
          tmuxSession,
          ';',
          'new-window',
          '-n',
          windowName,
          '-c',
          cwd,
        ];
        tmuxReused = false;
        console.log(
          `\x1b[36m🪟 Creating new window in tmux session:\x1b[0m ${tmuxSession} (${windowName})`
        );
      }
    } else {
      // Session doesn't exist - create it with first window and set theme inline
      shellArgs = [
        'new-session',
        '-s',
        tmuxSession,
        '-n',
        windowName,
        '-c',
        cwd,
        ';',
        'set-option',
        '-t',
        tmuxSession,
        'default-terminal',
        'tmux-256color',
        ';',
        'set-option',
        '-t',
        tmuxSession,
        'status-style',
        'bg=#2e9a92,fg=#000000',
        ';',
        'set-option',
        '-t',
        tmuxSession,
        'allow-passthrough',
        'on',
        ';',
        'set-option',
        '-ga',
        'terminal-features',
        'xterm*:hyperlinks',
        ';',
        'set-option',
        '-ga',
        'terminal-features',
        'tmux-256color:hyperlinks,RGB,extkeys',
        ';',
        'set-option',
        '-ga',
        'terminal-features',
        'xterm*:allow-passthrough',
        ';',
        'set-option',
        '-as',
        'terminal-overrides',
        ',*:allow-passthrough',
        ';',
        'set-option',
        '-as',
        'terminal-overrides',
        ',*:hyperlinks',
      ];
      tmuxReused = false;
      console.log(
        `\x1b[36m🚀 Creating tmux session:\x1b[0m ${tmuxSession} with window (${windowName}) + teal theme`
      );
    }

    // Resolve environment with user env vars if userId provided
    let env: Record<string, string> = { ...(process.env as Record<string, string>) };
    if (resolvedUserId) {
      const userEnv = await resolveUserEnvironment(resolvedUserId, this.db);
      console.log(
        `🔐 Loaded ${Object.keys(userEnv).length} env vars for user ${resolvedUserId.substring(0, 8)}`
      );
      env = { ...env, ...userEnv };
    }

    // Strip TMUX env vars to prevent nested sessions
    delete env.TMUX;
    delete env.TMUX_PANE;

    // Ensure terminal capabilities advertised to downstream processes
    if (!env.TERM) {
      env.TERM = 'xterm-256color';
    }
    if (!env.COLORTERM) {
      env.COLORTERM = 'truecolor';
    }
    if (!env.ENABLE_HYPERLINKS) {
      env.ENABLE_HYPERLINKS = '1';
    }
    if (!env.RICH_FORCE_COLOR) {
      env.RICH_FORCE_COLOR = '1';
    }
    if (!env.RICH_FORCE_HYPERLINK) {
      env.RICH_FORCE_HYPERLINK = '1';
    }
    if (!env.LANG) {
      env.LANG = 'C.UTF-8';
    }
    if (!env.LC_ALL) {
      env.LC_ALL = env.LANG;
    }
    if (!env.LC_CTYPE) {
      env.LC_CTYPE = env.LANG;
    }

    // Spawn PTY process with tmux (ALWAYS uses tmux now)
    const ptyProcess = pty.spawn('tmux', shellArgs, {
      name: 'xterm-256color',
      cols: data.cols || 80,
      rows: data.rows || 30,
      cwd,
      env,
    });

    // Store session
    this.sessions.set(terminalId, {
      terminalId,
      pty: ptyProcess,
      shell: 'tmux',
      cwd,
      userId: resolvedUserId,
      worktreeId: data.worktreeId,
      tmuxSession,
      createdAt: new Date(),
    });

    // Handle PTY output - broadcast to WebSocket clients
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

    return { terminalId, cwd, tmuxSession, tmuxReused, worktreeName };
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
      alive: true,
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
      session.pty.write(data.input);
    }

    if (data.resize) {
      // Use PTY resize method (non-blocking)
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

    session.pty.kill();
    this.sessions.delete(id);

    return { terminalId: id };
  }

  /**
   * Cleanup all terminals on shutdown
   */
  cleanup(): void {
    for (const session of this.sessions.values()) {
      session.pty.kill();
    }
    this.sessions.clear();
  }
}
