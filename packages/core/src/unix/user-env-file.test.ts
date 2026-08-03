import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { buildSpawnArgs } from './run-as-user.js';
import {
  attachEnvFileCleanup,
  type CleanupTarget,
  prepareImpersonationEnv,
} from './user-env-file.js';

vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));

describe('attachEnvFileCleanup', () => {
  function cleanupTarget(listeners: Map<string, () => void>): CleanupTarget {
    return {
      once(event, listener) {
        listeners.set(event, listener);
      },
    };
  }

  it('skips privileged cleanup when the launch wrapper already removed the env file', () => {
    const listeners = new Map<string, () => void>();

    attachEnvFileCleanup(cleanupTarget(listeners), {
      envFilePath: `/tmp/agor-env-absent-${process.pid}-${Date.now()}`,
      asUser: 'alice',
    });
    listeners.get('exit')?.();

    expect(execFileSync).not.toHaveBeenCalled();
  });

  it('still removes an env file left behind by a failed launch', () => {
    const listeners = new Map<string, () => void>();
    const path = join(tmpdir(), `agor-env-failed-${process.pid}-${Date.now()}`);
    writeFileSync(path, 'TOKEN=secret\n', { mode: 0o600 });

    attachEnvFileCleanup(cleanupTarget(listeners), { envFilePath: path });
    listeners.get('error')?.();

    expect(existsSync(path)).toBe(false);
  });
});

describe('prepareImpersonationEnv', () => {
  it('routes secrets only through the env file and keeps them out of spawn argv', () => {
    const secret = 'sk-ant-secret-must-not-appear-in-argv';
    const prepared = prepareImpersonationEnv({
      asUser: 'alice',
      env: { ANTHROPIC_API_KEY: secret, LOG_LEVEL: 'info' },
    });
    const spawnArgs = buildSpawnArgs('node', ['executor.js'], {
      asUser: 'alice',
      env: prepared.inlineEnv,
      envFilePath: prepared.envFilePath,
    });

    expect(prepared.inlineEnv).toEqual({ LOG_LEVEL: 'info' });
    expect([spawnArgs.cmd, ...spawnArgs.args].join('\n')).not.toContain(secret);
    expect(vi.mocked(execFileSync).mock.calls[0]?.[2]).toMatchObject({
      input: expect.stringContaining(secret),
    });
  });
});
