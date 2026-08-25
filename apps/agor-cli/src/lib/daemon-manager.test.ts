import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getDaemonIdentityFilePath,
  getDaemonPid,
  getLogFilePath,
  getManagedDaemonIdentity,
  getManagedDaemonInstanceId,
  readLogs,
  rotateDaemonLogIfNeeded,
} from './daemon-manager.js';

describe('daemon-manager logs', () => {
  let tempHome: string;

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agor-cli-logs-test-'));
    vi.spyOn(os, 'homedir').mockReturnValue(tempHome);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it('returns "No logs found" when daemon log is missing', () => {
    expect(readLogs(50)).toBe('No logs found');
    expect(fs.statSync(path.join(tempHome, '.agor')).mode & 0o777).toBe(0o700);
  });

  it('reads the CLI-managed daemon identity record', () => {
    fs.mkdirSync(path.dirname(getDaemonIdentityFilePath()), { recursive: true });
    fs.writeFileSync(getDaemonIdentityFilePath(), ' instance-id\n');
    expect(getManagedDaemonInstanceId()).toBe('instance-id');
  });

  it('reads structured identity records while retaining legacy compatibility', () => {
    fs.mkdirSync(path.dirname(getDaemonIdentityFilePath()), { recursive: true });
    fs.writeFileSync(
      getDaemonIdentityFilePath(),
      JSON.stringify({
        instanceId: 'instance-id',
        daemonUrl: 'http://127.0.0.1:4040',
        configPath: '/tmp/custom-agor.yaml',
      })
    );
    expect(getManagedDaemonIdentity()).toEqual({
      instanceId: 'instance-id',
      daemonUrl: 'http://127.0.0.1:4040',
      configPath: '/tmp/custom-agor.yaml',
    });
  });

  it('clears both ownership records when the PID is stale', () => {
    fs.mkdirSync(path.dirname(getDaemonIdentityFilePath()), { recursive: true });
    fs.writeFileSync(path.join(tempHome, '.agor', 'daemon.pid'), '424242');
    fs.writeFileSync(getDaemonIdentityFilePath(), 'stale-instance');
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('missing process'), { code: 'ESRCH' });
    });

    expect(getDaemonPid()).toBeNull();
    expect(fs.existsSync(path.join(tempHome, '.agor', 'daemon.pid'))).toBe(false);
    expect(fs.existsSync(getDaemonIdentityFilePath())).toBe(false);
  });

  it('returns the last requested lines without reading the whole file', () => {
    const logFile = getLogFilePath();
    const allLines = Array.from({ length: 5000 }, (_, i) => `line-${i + 1}`);
    fs.writeFileSync(logFile, `${allLines.join('\n')}\n`);

    const readFileSpy = vi.spyOn(fs, 'readFileSync');
    const output = readLogs(3);

    expect(output).toBe('line-4998\nline-4999\nline-5000');
    expect(readFileSpy).not.toHaveBeenCalled();
  });

  it('returns empty string when lines is zero or negative', () => {
    const logFile = getLogFilePath();
    fs.writeFileSync(logFile, 'line-1\nline-2\n');

    expect(readLogs(0)).toBe('');
    expect(readLogs(-3)).toBe('');
  });

  it('falls back to default line count for non-finite line values', () => {
    const logFile = getLogFilePath();
    const allLines = Array.from({ length: 80 }, (_, i) => `line-${i + 1}`);
    fs.writeFileSync(logFile, `${allLines.join('\n')}\n`);

    expect(readLogs(Number.NaN)).toBe(allLines.slice(-50).join('\n'));
  });

  it('handles very large log files without ERR_STRING_TOO_LONG', () => {
    const logFile = getLogFilePath();
    const fd = fs.openSync(logFile, 'w');
    try {
      const hugeBytes = 600 * 1024 * 1024;
      const trailer = 'tail-1\ntail-2\n';
      const trailerBytes = Buffer.byteLength(trailer, 'utf-8');

      fs.ftruncateSync(fd, hugeBytes);
      fs.writeSync(fd, trailer, hugeBytes - trailerBytes, 'utf-8');
    } finally {
      fs.closeSync(fd);
    }

    expect(() => readLogs(2)).not.toThrow();
    expect(readLogs(2)).toBe('tail-1\ntail-2');
  });

  it('adds truncation notice when safety cap is hit before enough lines are found', () => {
    const logFile = getLogFilePath();
    const nineMbSingleLine = `${'x'.repeat(9 * 1024 * 1024)}\n`;
    fs.writeFileSync(logFile, nineMbSingleLine);

    const output = readLogs(2);
    expect(output).toContain('[output truncated: scanned last 8MB of 9MB]');
  });

  it('rotates oversized logs and keeps bounded history', () => {
    const logFile = getLogFilePath();

    fs.writeFileSync(logFile, 'first');
    rotateDaemonLogIfNeeded(logFile, { maxBytes: 1, maxFiles: 2 });
    expect(fs.readFileSync(`${logFile}.1`, 'utf-8')).toBe('first');

    fs.writeFileSync(logFile, 'second');
    rotateDaemonLogIfNeeded(logFile, { maxBytes: 1, maxFiles: 2 });
    expect(fs.readFileSync(`${logFile}.1`, 'utf-8')).toBe('second');
    expect(fs.readFileSync(`${logFile}.2`, 'utf-8')).toBe('first');

    fs.writeFileSync(logFile, 'third');
    rotateDaemonLogIfNeeded(logFile, { maxBytes: 1, maxFiles: 2 });
    expect(fs.readFileSync(`${logFile}.1`, 'utf-8')).toBe('third');
    expect(fs.readFileSync(`${logFile}.2`, 'utf-8')).toBe('second');
    expect(fs.existsSync(`${logFile}.3`)).toBe(false);
  });

  it('does not rotate when log size equals maxBytes threshold', () => {
    const logFile = getLogFilePath();
    fs.writeFileSync(logFile, '12345');
    rotateDaemonLogIfNeeded(logFile, { maxBytes: 5, maxFiles: 2 });

    expect(fs.existsSync(logFile)).toBe(true);
    expect(fs.existsSync(`${logFile}.1`)).toBe(false);
  });
});
