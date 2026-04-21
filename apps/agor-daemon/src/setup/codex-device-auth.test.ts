import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { AgorConfig } from '@agor/core/config';
import { describe, expect, it } from 'vitest';
import {
  CodexDeviceAuthManager,
  type CodexDeviceAuthProcess,
  parseDeviceAuthOutput,
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

describe('CodexDeviceAuthManager', () => {
  it('deduplicates pending flows by user context key', async () => {
    const config: AgorConfig = {};
    const process = new FakeCodexDeviceAuthProcess();
    const manager = new CodexDeviceAuthManager({
      spawnProcess: async (_config, _options, context) => {
        queueMicrotask(() => {
          process.stdout.write('Open https://chatgpt.com/device and enter ABCD-EFGHI');
        });

        return {
          process,
          context,
        };
      },
    });

    const first = await manager.start(config, { agorUserId: 'user-123' });
    const second = await manager.start(config, { agorUserId: 'user-123' });

    expect(second.flowId).toBe(first.flowId);
  });
});
