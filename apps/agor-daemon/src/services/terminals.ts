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
 */

import os from 'node:os';
import { resolveUserEnvironment } from '@agor/core/config';
import type { Database } from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import type { UserID } from '@agor/core/types';
import type { IPty } from '@homebridge/node-pty-prebuilt-multiarch';
import * as pty from '@homebridge/node-pty-prebuilt-multiarch';

interface TerminalSession {
  terminalId: string;
  pty: IPty;
  shell: string;
  cwd: string;
  userId?: UserID; // User context for env resolution
  createdAt: Date;
}

interface CreateTerminalData {
  cwd?: string;
  shell?: string;
  rows?: number;
  cols?: number;
  userId?: UserID; // User context for env resolution
}

interface ResizeTerminalData {
  rows: number;
  cols: number;
}

/**
 * Terminals service - manages PTY sessions
 */
export class TerminalsService {
  private sessions = new Map<string, TerminalSession>();
  private app: Application;
  private db: Database;

  constructor(app: Application, db: Database) {
    this.app = app;
    this.db = db;
  }

  /**
   * Create a new terminal session
   */
  async create(data: CreateTerminalData): Promise<{ terminalId: string; cwd: string }> {
    const terminalId = `term-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const cwd = data.cwd || os.homedir();
    const shell = data.shell || (os.platform() === 'win32' ? 'powershell.exe' : 'bash');

    // Resolve environment with user env vars if userId provided
    let env: Record<string, string> = process.env as Record<string, string>;
    if (data.userId) {
      env = await resolveUserEnvironment(data.userId, this.db);
      console.log(
        `🔐 Loaded ${Object.keys(env).length} env vars for user ${data.userId.substring(0, 8)}`
      );
    }

    // Spawn PTY process
    const ptyProcess = pty.spawn(shell, [], {
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

    return { terminalId, cwd };
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
