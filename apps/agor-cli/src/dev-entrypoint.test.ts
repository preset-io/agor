import { execFile } from 'node:child_process';
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
});
