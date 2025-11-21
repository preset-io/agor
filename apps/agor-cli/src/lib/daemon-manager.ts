/**
 * Daemon Manager - Lifecycle management for agor-daemon
 *
 * Handles starting, stopping, and monitoring the daemon process in production mode.
 * Uses PID files and detached processes for background execution.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Get Agor home directory (~/.agor)
 */
export function getAgorHome(): string {
  return path.join(os.homedir(), '.agor');
}

/**
 * Get PID file path
 */
export function getPidFilePath(): string {
  return path.join(getAgorHome(), 'daemon.pid');
}

/**
 * Get log file path
 */
export function getLogFilePath(): string {
  const logsDir = path.join(getAgorHome(), 'logs');
  if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
  }
  return path.join(logsDir, 'daemon.log');
}

/**
 * Check if daemon process is running
 *
 * @returns PID if running, null otherwise
 */
export function getDaemonPid(): number | null {
  const pidFile = getPidFilePath();

  if (!fs.existsSync(pidFile)) {
    return null;
  }

  const pid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10);

  // Check if process is actually running
  try {
    // Sending signal 0 checks if process exists without killing it
    process.kill(pid, 0);
    return pid;
  } catch {
    // Process not found, clean up stale PID file
    fs.unlinkSync(pidFile);
    return null;
  }
}

/**
 * Start daemon in background
 *
 * @param daemonPath - Path to daemon binary
 * @returns PID of started daemon
 * @throws Error if daemon already running or failed to start
 */
export function startDaemon(daemonPath: string): number {
  // Check if already running
  const existingPid = getDaemonPid();
  if (existingPid !== null) {
    throw new Error(`Daemon already running (PID ${existingPid})`);
  }

  // Ensure daemon binary exists
  if (!fs.existsSync(daemonPath)) {
    throw new Error(`Daemon binary not found at: ${daemonPath}`);
  }

  // Ensure log directory exists
  const logFile = getLogFilePath();
  const logStream = fs.openSync(logFile, 'a');

  // Spawn daemon in detached mode
  const child = spawn('node', [daemonPath], {
    detached: true,
    stdio: ['ignore', logStream, logStream],
    env: {
      ...process.env,
      NODE_ENV: 'production',
    },
  });

  // Detach from parent process
  child.unref();

  // Write PID file
  fs.writeFileSync(getPidFilePath(), child.pid!.toString());

  // Close log stream (child process keeps it open)
  fs.closeSync(logStream);

  return child.pid!;
}

/**
 * Stop daemon gracefully
 *
 * @returns true if stopped, false if not running
 * @throws Error if failed to stop
 */
export function stopDaemon(): boolean {
  const pid = getDaemonPid();

  if (pid === null) {
    return false;
  }

  try {
    // Send SIGTERM for graceful shutdown
    process.kill(pid, 'SIGTERM');

    // Wait up to 5 seconds for process to exit
    let attempts = 0;
    const maxAttempts = 50;

    while (attempts < maxAttempts) {
      try {
        process.kill(pid, 0); // Check if still running
        // Still running, wait a bit
        const waitTime = 100; // 100ms
        const start = Date.now();
        while (Date.now() - start < waitTime) {
          // Busy wait (blocking is fine for CLI)
        }
        attempts++;
      } catch {
        // Process exited
        break;
      }
    }

    // If still running after timeout, force kill
    try {
      process.kill(pid, 0);
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already dead
    }

    // Clean up PID file
    const pidFile = getPidFilePath();
    if (fs.existsSync(pidFile)) {
      fs.unlinkSync(pidFile);
    }

    return true;
  } catch (error) {
    throw new Error(`Failed to stop daemon: ${(error as Error).message}`);
  }
}

/**
 * Get last N lines from log file
 *
 * @param lines - Number of lines to read (default: 50)
 * @returns Log content
 */
export function readLogs(lines: number = 50): string {
  const logFile = getLogFilePath();

  if (!fs.existsSync(logFile)) {
    return 'No logs found';
  }

  const content = fs.readFileSync(logFile, 'utf-8');
  const allLines = content.split('\n').filter((line) => line.trim() !== '');
  const lastLines = allLines.slice(-lines);

  return lastLines.join('\n');
}
