import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { AgorConfig } from '@agor/core/config';
import { describe, expect, it } from 'vitest';
import {
  buildDeviceAuthSpawnEnv,
  CodexDeviceAuthManager,
  type CodexDeviceAuthProcess,
  parseDeviceAuthOutput,
  resolveCodexDeviceAuthSpawnContext,
} from './codex-device-auth.js';

class FakeCodexDeviceAuthProcess extends EventEmitter implements CodexDeviceAuthProcess {
  stdout = new PassThrough();
  stderr = new PassThrough();

  kill(): boolean {
    this.emit('exit', null, 'SIGTERM');
    return true;
  }
}

describe('parseDeviceAuthOutput', () => {
  it('parses verification URI and user code from codex login --device-auth output', () => {
    expect(parseDeviceAuthOutput('Open https://chatgpt.com/device and enter ABCD-EFGHI')).toEqual({
      verificationUri: 'https://chatgpt.com/device',
      userCode: 'ABCD-EFGHI',
    });
  });
});

describe('buildDeviceAuthSpawnEnv', () => {
  it('scrubs OPENAI_API_KEY before launching device auth on the current-user path', () => {
    expect(
      buildDeviceAuthSpawnEnv({
        OPENAI_API_KEY: 'sk-test',
        PATH: '/usr/bin',
      })
    ).toEqual({
      PATH: '/usr/bin',
    });
  });
});

describe('CodexDeviceAuthManager', () => {
  it('deduplicates pending flows by user context key', async () => {
    const config: AgorConfig = {};
    let releaseSpawn: (() => void) | null = null;
    const spawnGate = new Promise<void>((resolve) => {
      releaseSpawn = resolve;
    });
    let spawnCount = 0;
    const manager = new CodexDeviceAuthManager({
      spawnProcess: async (_config, _options, context) => {
        spawnCount += 1;
        const process = new FakeCodexDeviceAuthProcess();
        await spawnGate;
        queueMicrotask(() => {
          process.stdout.write('Open https://chatgpt.com/device and enter ABCD-EFGHI');
        });

        return {
          process,
          context,
        };
      },
    });

    const firstPromise = manager.start(config, { agorUserId: 'user-123' });
    const secondPromise = manager.start(config, { agorUserId: 'user-123' });

    await Promise.resolve();
    expect(spawnCount).toBe(1);
    releaseSpawn?.();

    const [first, second] = await Promise.all([firstPromise, secondPromise]);

    expect(second.flowId).toBe(first.flowId);
  });

  it('propagates an explicit session Unix user into the spawn context', () => {
    const config: AgorConfig = {};

    expect(
      resolveCodexDeviceAuthSpawnContext(config, {
        agorUserId: 'user-123',
        sessionUnixUsername: 'alice',
      }).executionUnixUser
    ).toBe('alice');
  });
});
