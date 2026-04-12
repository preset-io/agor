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

const DEFAULT_LOG_LINES = 50;
const MIN_TAIL_READ_BYTES = 64 * 1024;
const AVG_LOG_LINE_BYTES = 256;
const MAX_TAIL_READ_BYTES = 8 * 1024 * 1024;
const DEFAULT_ROTATE_MAX_BYTES = 50 * 1024 * 1024; // 50MB
const DEFAULT_ROTATE_MAX_FILES = 5;

export interface DaemonLogRotationOptions {
  maxBytes?: number;
  maxFiles?: number;
}

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

  try {
    rotateDaemonLogIfNeeded(logFile);
  } catch (error) {
    console.warn(`⚠ Failed to rotate daemon logs: ${(error as Error).message}`);
  }

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
 * Reads from the end of the file with a bounded window to avoid loading
 * arbitrarily large logs into memory.
 *
 * @param lines - Number of lines to read (default: 50)
 * @returns Log content
 */
export function readLogs(lines: number = DEFAULT_LOG_LINES): string {
  const logFile = getLogFilePath();

  if (!fs.existsSync(logFile)) {
    return 'No logs found';
  }

  const safeLines = sanitizeRequestedLineCount(lines);
  if (safeLines <= 0) {
    return '';
  }

  const fd = fs.openSync(logFile, 'r');
  try {
    const fileSize = fs.fstatSync(fd).size;
    if (fileSize <= 0) {
      return '';
    }

    const maxReadableBytes = Math.min(fileSize, MAX_TAIL_READ_BYTES);
    let bytesToRead = Math.min(
      maxReadableBytes,
      Math.max(MIN_TAIL_READ_BYTES, safeLines * AVG_LOG_LINE_BYTES)
    );

    let lastLines: string[] = [];
    let truncatedByCap = false;
    while (bytesToRead <= maxReadableBytes) {
      const tailBuffer = readTailBuffer(fd, fileSize, bytesToRead);
      const tailContent = tailBuffer.toString('utf-8').replaceAll('\0', '').replace(/\r\n/g, '\n');
      const allLines = tailContent.split('\n').filter((line) => line.trim() !== '');
      lastLines = allLines.slice(-safeLines);

      if (
        bytesToRead === maxReadableBytes &&
        fileSize > maxReadableBytes &&
        allLines.length < safeLines
      ) {
        truncatedByCap = true;
      }

      if (allLines.length >= safeLines || bytesToRead === maxReadableBytes) {
        break;
      }

      bytesToRead = Math.min(maxReadableBytes, bytesToRead * 2);
    }

    const logText = lastLines.join('\n');
    if (!truncatedByCap) {
      return logText;
    }

    const prefix = `[output truncated: scanned last ${formatBytes(maxReadableBytes)} of ${formatBytes(fileSize)}]`;
    return logText.length > 0 ? `${prefix}\n${logText}` : prefix;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Rotate daemon log file if it exceeds configured size.
 * Retains N rotated files: daemon.log.1 ... daemon.log.N
 */
export function rotateDaemonLogIfNeeded(
  logFile: string,
  options: DaemonLogRotationOptions = {}
): void {
  if (!fs.existsSync(logFile)) {
    return;
  }

  const maxBytes = Math.max(1, Math.floor(options.maxBytes ?? DEFAULT_ROTATE_MAX_BYTES));
  const maxFiles = Math.max(1, Math.floor(options.maxFiles ?? DEFAULT_ROTATE_MAX_FILES));
  const logSize = fs.statSync(logFile).size;

  if (logSize <= maxBytes) {
    return;
  }

  const oldestLog = `${logFile}.${maxFiles}`;
  if (fs.existsSync(oldestLog)) {
    fs.unlinkSync(oldestLog);
  }

  for (let i = maxFiles - 1; i >= 1; i--) {
    const src = `${logFile}.${i}`;
    const dest = `${logFile}.${i + 1}`;

    if (!fs.existsSync(src)) {
      continue;
    }

    if (fs.existsSync(dest)) {
      fs.unlinkSync(dest);
    }
    fs.renameSync(src, dest);
  }

  fs.renameSync(logFile, `${logFile}.1`);
}

function sanitizeRequestedLineCount(lines: number): number {
  if (!Number.isFinite(lines)) {
    return DEFAULT_LOG_LINES;
  }

  const parsed = Math.floor(lines);
  return Math.max(0, parsed);
}

function readTailBuffer(fd: number, fileSize: number, bytesToRead: number): Buffer {
  const readLength = Math.min(bytesToRead, fileSize);
  const start = fileSize - readLength;
  const buffer = Buffer.allocUnsafe(readLength);
  const bytesRead = fs.readSync(fd, buffer, 0, readLength, start);

  return bytesRead === readLength ? buffer : buffer.subarray(0, bytesRead);
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${Math.round((bytes / (1024 * 1024)) * 10) / 10}MB`;
  }
  if (bytes >= 1024) {
    return `${Math.round((bytes / 1024) * 10) / 10}KB`;
  }
  return `${bytes}B`;
}
