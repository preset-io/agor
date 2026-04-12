import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getLogFilePath, readLogs, rotateDaemonLogIfNeeded } from './daemon-manager.js';

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
