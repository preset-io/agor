import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const cliRoot = resolve(import.meta.dirname, '../../..');

function runDb(
  command: 'status' | 'migrate',
  args: string[],
  env: Record<string, string>
): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', 'bin/dev.ts', 'db', command, ...args],
      {
        cwd: cliRoot,
        env: {
          ...process.env,
          ...env,
          NO_COLOR: '1',
          NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --conditions=source`.trim(),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += String(chunk)));
    child.stderr.on('data', (chunk) => (stderr += String(chunk)));
    child.once('error', reject);
    child.once('close', (code) => resolveRun({ code, stdout, stderr }));
  });
}

describe('db status command', () => {
  it('emits only the strict JSON contract for a fresh database', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agor-db-status-'));
    try {
      const result = await runDb('status', ['--json'], {
        AGOR_DB_DIALECT: 'sqlite',
        AGOR_DB_PATH: `file:${join(directory, 'fresh.db')}`,
      });
      expect(result.code).toBe(0);
      const output = JSON.parse(result.stdout) as Record<string, unknown>;
      expect(Object.keys(output).sort()).toEqual([
        'appliedMigrations',
        'databaseAheadOfBinary',
        'pendingMigrations',
        'requiresOfflineCutover',
        'schemaVersion',
      ]);
      expect(output.schemaVersion).toBe(1);
      expect(output.appliedMigrations).toEqual([]);
      expect(Array.isArray(output.pendingMigrations)).toBe(true);
      expect((output.pendingMigrations as unknown[]).length).toBeGreaterThan(0);
      expect(output.requiresOfflineCutover).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('does not expose credentials when status fails', async () => {
    const secret = 'status-secret-value';
    const result = await runDb('status', ['--json'], {
      AGOR_DB_DIALECT: 'postgresql',
      DATABASE_URL: `postgresql://user:${secret}@[invalid/database`,
    });
    expect(result.code).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).not.toContain(secret);
    expect(`${result.stdout}\n${result.stderr}`).not.toContain('postgresql://user:');
  });

  it('does not expose credentials when migration fails', async () => {
    const secret = 'migration-secret-value';
    const result = await runDb('migrate', ['--yes'], {
      AGOR_DB_DIALECT: 'postgresql',
      DATABASE_URL: `postgresql://user:${secret}@[invalid/database`,
    });
    expect(result.code).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).not.toContain(secret);
    expect(`${result.stdout}\n${result.stderr}`).not.toContain('postgresql://user:');
  });
});
