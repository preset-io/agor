import { execFileSync } from 'node:child_process';
import { existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildSpawnArgs, escapeShellArg } from './run-as-user.js';
import {
  attachEnvFileCleanup,
  type CleanupTarget,
  prepareImpersonationEnv,
} from './user-env-file.js';

vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));

function cleanupTarget(listeners: Map<string, () => void>): CleanupTarget {
  return {
    once(event, listener) {
      listeners.set(event, listener);
    },
  };
}

describe('attachEnvFileCleanup', () => {
  beforeEach(() => {
    vi.mocked(execFileSync).mockReset();
  });

  it('skips privileged cleanup when the launch wrapper already removed the env file', () => {
    const listeners = new Map<string, () => void>();

    attachEnvFileCleanup(cleanupTarget(listeners), {
      envFilePath: join(tmpdir(), `agor-env-absent-${process.pid}-${Date.now()}`),
      asUser: 'alice',
    });
    listeners.get('exit')?.();

    expect(execFileSync).not.toHaveBeenCalled();
  });

  it('removes a failed-launch file once across error and exit cleanup', () => {
    const listeners = new Map<string, () => void>();
    const path = join(tmpdir(), `agor-env-failed-${process.pid}-${Date.now()}`);
    writeFileSync(path, 'TOKEN=secret\n', { mode: 0o600 });
    vi.mocked(execFileSync).mockImplementation((_file, args) => {
      const cleanupPath = args?.at(-1);
      if (!cleanupPath) throw new Error('expected cleanup path');
      unlinkSync(cleanupPath);
      return Buffer.alloc(0);
    });

    attachEnvFileCleanup(cleanupTarget(listeners), { envFilePath: path, asUser: 'alice' });
    listeners.get('error')?.();
    listeners.get('exit')?.();

    expect(existsSync(path)).toBe(false);
    expect(execFileSync).toHaveBeenCalledTimes(1);
    expect(execFileSync).toHaveBeenCalledWith(
      'sudo',
      ['-n', '-u', 'alice', 'rm', '-f', '--', path],
      expect.objectContaining({ stdio: 'ignore' })
    );
  });
});

describe('prepareImpersonationEnv', () => {
  beforeEach(() => {
    vi.mocked(execFileSync).mockReset();
  });

  it('keeps real secret values out of argv while preserving non-secret startup env', () => {
    const secret = "sk-ant-secret with 'quotes'=and\nnewlines";
    const inlineEnv = {
      LOG_LEVEL: 'warn',
      NODE_ENV: 'production',
      GIT_CONFIG_PARAMETERS: "'transfer.credentialsInUrl'='die'",
    };
    const prepared = prepareImpersonationEnv({
      asUser: 'alice',
      env: { ANTHROPIC_API_KEY: secret, ...inlineEnv },
    });
    const spawnArgs = buildSpawnArgs('node', ['executor.js', '--stdin'], {
      asUser: 'alice',
      env: prepared.inlineEnv,
      envFilePath: prepared.envFilePath,
    });

    expect(prepared.inlineEnv).toEqual(inlineEnv);
    expect(spawnArgs.args.slice(8)).toEqual([
      ...Object.entries(inlineEnv).map(([key, value]) => `${key}=${value}`),
      'node',
      'executor.js',
      '--stdin',
    ]);
    expect([spawnArgs.cmd, ...spawnArgs.args].join('\n')).not.toContain(secret);
    expect(vi.mocked(execFileSync).mock.calls[0]?.[2]).toMatchObject({
      input: `ANTHROPIC_API_KEY=${escapeShellArg(secret)}\n`,
    });
  });
});
