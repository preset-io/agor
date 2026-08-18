import { spawn } from 'node:child_process';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const cliRoot = resolve(import.meta.dirname, '../../..');

function runUserList(home: string): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolveRun, reject) => {
    const env = { ...process.env };
    delete env.AGOR_API_KEY;
    delete env.AGOR_DEPLOYMENT_ID;
    delete env.DAEMON_URL;

    const child = spawn(process.execPath, ['--import', 'tsx', 'bin/dev.ts', 'user', 'list'], {
      cwd: cliRoot,
      env: {
        ...env,
        HOME: home,
        NO_COLOR: '1',
        NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --conditions=source`.trim(),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += String(chunk)));
    child.stderr.on('data', (chunk) => (stderr += String(chunk)));
    child.once('error', reject);
    child.once('close', (code) => resolveRun({ code, stdout, stderr }));
  });
}

describe('user list command', () => {
  it('requires a connection instead of opening the local database', async () => {
    const home = await mkdtemp(join(tmpdir(), 'agor-user-list-'));
    try {
      const result = await runUserList(home);

      expect(result.code).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toContain('Not authenticated');
      await expect(access(join(home, '.agor', 'agor.db'))).rejects.toThrow();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
