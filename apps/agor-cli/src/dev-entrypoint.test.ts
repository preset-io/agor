import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

describe('CLI development entrypoint', () => {
  it('runs against workspace source exports without requiring a prior core build', async () => {
    const { stdout } = await execFileAsync('pnpm', ['dev', '--version'], {
      cwd: new URL('..', import.meta.url),
      env: process.env,
      timeout: 30_000,
    });

    expect(stdout).toMatch(/@agor\/cli\/\S+/);
  }, 35_000);

  it('keeps the workspace-root CLI entrypoint on the same source-resolving path', async () => {
    const { stdout } = await execFileAsync('pnpm', ['--workspace-root', 'agor', '--version'], {
      cwd: new URL('..', import.meta.url),
      env: process.env,
      timeout: 30_000,
    });

    expect(stdout).toMatch(/@agor\/cli\/\S+/);
  }, 35_000);

  it('runs the version command without oclif argument-parsing warnings', async () => {
    const home = await mkdtemp(join(tmpdir(), 'agor-cli-version-'));
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      DAEMON_URL: 'http://127.0.0.1:1',
      HOME: home,
    };
    delete env.AGOR_OUTER_SANDBOX;
    try {
      const { stderr, stdout } = await execFileAsync('pnpm', ['dev', 'version'], {
        cwd: new URL('..', import.meta.url),
        env,
        timeout: 30_000,
      });

      expect(stdout).toContain('Daemon:');
      expect(stderr).not.toContain('did not parse its arguments');
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }, 35_000);
});
