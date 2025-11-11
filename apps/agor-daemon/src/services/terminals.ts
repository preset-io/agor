/**
 * Terminals Service
 *
 * Manages PTY (pseudo-terminal) sessions for web-based terminal access.
 * Uses @homebridge/node-pty-prebuilt-multiarch for cross-platform PTY support.
 *
 * Features:
 * - Full terminal emulation (vim, nano, htop, etc.)
 * - Job control (Ctrl+C, Ctrl+Z)
 * - Terminal resizing
 * - ANSI colors and escape codes
 * - Tmux integration for persistent sessions
 */

import { execSync } from 'node:child_process';
import os from 'node:os';
import { resolveUserEnvironment } from '@agor/core/config';
import { formatShortId, WorktreeRepository, type Database } from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import type { UserID, WorktreeID } from '@agor/core/types';
import type { IPty } from '@homebridge/node-pty-prebuilt-multiarch';
import * as pty from '@homebridge/node-pty-prebuilt-multiarch';

interface TerminalSession {
  terminalId: string;
  pty: IPty;
  shell: string;
  cwd: string;
  userId?: UserID; // User context for env resolution
  worktreeId?: WorktreeID; // Worktree context for tmux session naming
  tmuxSession?: string; // Tmux session name if using tmux
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
 * Terminals service - manages PTY sessions
 */
export class TerminalsService {
  private sessions = new Map<string, TerminalSession>();
  private app: Application;
  private db: Database;
  private hasTmux: boolean;

  constructor(app: Application, db: Database) {
    this.app = app;
    this.db = db;
    this.hasTmux = isTmuxAvailable();

    if (this.hasTmux) {
      console.log('✅ tmux detected - persistent terminal sessions enabled');
    } else {
      console.log('ℹ️  tmux not found - using ephemeral terminal sessions');
    }
  }

  /**
   * Create a new terminal session
   */
  async create(data: CreateTerminalData): Promise<{
    terminalId: string;
    cwd: string;
    tmuxSession?: string;
    tmuxReused?: boolean;
    worktreeName?: string;
  }> {
    const terminalId = `term-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

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

    // Determine shell and tmux configuration
    let shell: string;
    let shellArgs: string[] = [];
    let tmuxSession: string | undefined;
    let tmuxReused = false;

    if (this.hasTmux && worktree) {
      // Use single shared tmux session with one window per worktree
      tmuxSession = 'agor';
      const sessionExists = tmuxSessionExists(tmuxSession);
      const windowName = worktreeName || 'unnamed';

      shell = 'tmux';

      if (sessionExists) {
        // Session exists - check if this worktree has a window
        const windowIndex = findTmuxWindow(tmuxSession, windowName);

        if (windowIndex !== null) {
          // Window exists - attach and select it
          shellArgs = ['attach-session', '-t', `${tmuxSession}:${windowIndex}`];
          tmuxReused = true;
          console.log(`🔗 Reusing tmux window: ${tmuxSession}:${windowIndex} (${windowName})`);
        } else {
          // Window doesn't exist - attach and create new window
          shellArgs = [
            'attach-session',
            '-t',
            tmuxSession,
            '\;',
            'new-window',
            '-n',
            windowName,
            '-c',
            cwd,
          ];
          tmuxReused = false;
          console.log(`🪟 Creating new window in tmux session: ${tmuxSession} (${windowName})`);
        }
      } else {
        // Session doesn't exist - create it with first window
        shellArgs = ['new-session', '-s', tmuxSession, '-n', windowName, '-c', cwd];
        tmuxReused = false;
        console.log(`🚀 Creating tmux session: ${tmuxSession} with window (${windowName})`);
      }
    } else {
      // Fallback to regular shell
      shell = data.shell || (os.platform() === 'win32' ? 'powershell.exe' : 'bash');
    }

    // Resolve environment with user env vars if userId provided
    let env: Record<string, string> = process.env as Record<string, string>;
    if (data.userId) {
      env = await resolveUserEnvironment(data.userId, this.db);
      console.log(
        `🔐 Loaded ${Object.keys(env).length} env vars for user ${data.userId.substring(0, 8)}`
      );
    }

    // Spawn PTY process
    const ptyProcess = pty.spawn(shell, shellArgs, {
      name: 'xterm-color',
      cols: data.cols || 80,
      rows: data.rows || 30,
      cwd,
      env, // Use resolved environment
    });

    // Store session
    this.sessions.set(terminalId, {
      terminalId,
      pty: ptyProcess,
      shell,
      cwd,
      userId: data.userId,
      worktreeId: data.worktreeId,
      tmuxSession,
      createdAt: new Date(),
    });

    // Handle PTY output - broadcast to WebSocket clients
    ptyProcess.onData(data => {
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
    return Array.from(this.sessions.values()).map(session => ({
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
