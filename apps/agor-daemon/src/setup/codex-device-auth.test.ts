import { EventEmitter } from 'node:events';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';
import type { AgorConfig } from '@agor/core/config';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildDeviceAuthSpawnEnv,
  buildDeviceAuthSpawnOptions,
  CodexDeviceAuthManager,
  type CodexDeviceAuthProcess,
  ensureCodexFileCredentialStore,
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

let tempDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-device-auth-'));
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

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

  it('injects scrubbed env vars into the impersonated spawn command', () => {
    const spawnOptions = buildDeviceAuthSpawnOptions(
      {
        codexHome: '/tmp/.agor/codex/users/user-123',
        executionUnixUser: 'alice',
      },
      {
        OPENAI_API_KEY: 'sk-test',
        PATH: '/usr/bin',
      }
    );

    expect(spawnOptions.cmd).toBe('sudo');
    expect(spawnOptions.args.join(' ')).toContain("PATH='/usr/bin'");
    expect(spawnOptions.args.join(' ')).not.toContain('OPENAI_API_KEY');
    expect(spawnOptions.env).toEqual({
      PATH: '/usr/bin',
    });
  });
});

describe('ensureCodexFileCredentialStore', () => {
  it('creates a file-backed credential-store config when missing', async () => {
    await ensureCodexFileCredentialStore(tempDir);

    await expect(fs.readFile(path.join(tempDir, 'config.toml'), 'utf8')).resolves.toBe(
      'cli_auth_credentials_store = "file"\n'
    );
  });

  it('preserves unrelated config while forcing file-backed credentials', async () => {
    const configPath = path.join(tempDir, 'config.toml');
    await fs.writeFile(
      configPath,
      [
        'model = "gpt-5"',
        'approval_policy = "on-failure"',
        'cli_auth_credentials_store = "keyring"',
      ].join('\n'),
      'utf8'
    );

    await ensureCodexFileCredentialStore(tempDir);
    const nextConfig = await fs.readFile(configPath, 'utf8');

    expect(nextConfig).toContain('model = "gpt-5"');
    expect(nextConfig).toContain('approval_policy = "on-failure"');
    expect(nextConfig).toContain('cli_auth_credentials_store = "file"');
    expect(nextConfig).not.toContain('cli_auth_credentials_store = "keyring"');
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
