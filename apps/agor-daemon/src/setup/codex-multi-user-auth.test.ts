import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');

  return {
    ...actual,
    homedir: vi.fn(),
  };
});

vi.mock('@agor/core/config', async () => {
  const actual = await vi.importActual<typeof import('@agor/core/config')>('@agor/core/config');

  return {
    ...actual,
    resolveApiKey: vi.fn().mockResolvedValue({
      apiKey: undefined,
      source: 'none',
      useNativeAuth: true,
    }),
  };
});

import { resolveApiKey } from '@agor/core/config';
import { CodexAuthStatusManager } from './codex-auth-status.js';
import { CodexDeviceAuthManager } from './codex-device-auth.js';

async function installFakeCodexCli(rootDir: string): Promise<string> {
  const binDir = path.join(rootDir, 'bin');
  const fakeCodexPath = path.join(binDir, 'codex');
  const script = `#!/usr/bin/env node
const fs = require('node:fs/promises');
const path = require('node:path');

function buildUserCode(userId) {
  const suffix = Buffer.from(userId).toString('hex').toUpperCase().slice(-5).padStart(5, '0');
  return \`ABCD-\${suffix}\`;
}

async function main() {
  const args = process.argv.slice(2);
  const codexHome = process.env.CODEX_HOME;

  if (!codexHome) {
    console.error('Missing CODEX_HOME');
    process.exit(1);
  }

  if (args[0] === 'login' && args[1] === '--device-auth') {
    await fs.mkdir(codexHome, { recursive: true });
    const userId = path.basename(codexHome);
    await fs.writeFile(
      path.join(codexHome, 'auth.json'),
      JSON.stringify({ access_token: \`token-\${userId}\`, userId }, null, 2)
    );
    await fs.writeFile(
      path.join(codexHome, 'config.toml'),
      'cli_auth_credentials_store = "file"\\n',
      'utf8'
    );

    process.stdout.write(
      \`Open https://chatgpt.com/device and enter \${buildUserCode(userId)}\\n\`
    );
    setTimeout(() => process.exit(0), 10);
    return;
  }

  if (args[0] === 'login' && args[1] === 'status') {
    try {
      await fs.access(path.join(codexHome, 'auth.json'));
      process.stdout.write('Logged in using ChatGPT\\n');
    } catch {
      process.stdout.write('Not logged in\\n');
    }
    process.exit(0);
    return;
  }

  console.error(\`Unsupported fake codex command: \${args.join(' ')}\`);
  process.exit(1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
`;

  await fs.mkdir(binDir, { recursive: true });
  await fs.writeFile(fakeCodexPath, script, 'utf8');
  await fs.chmod(fakeCodexPath, 0o755);

  return fakeCodexPath;
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000, intervalMs = 20): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error('Timed out waiting for condition');
}

describe('multi-user Codex auth flow', () => {
  let tempDir: string;
  let originalPath: string | undefined;
  let originalHome: string | undefined;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agor-codex-multi-user-'));
    originalPath = process.env.PATH;
    originalHome = process.env.HOME;
    await installFakeCodexCli(tempDir);
    await fs.writeFile(
      path.join(tempDir, '.profile'),
      `export PATH="${path.join(tempDir, 'bin')}:$PATH"\n`,
      'utf8'
    );
    process.env.PATH = `${path.join(tempDir, 'bin')}:${originalPath ?? ''}`;
    process.env.HOME = tempDir;
    vi.mocked(os.homedir).mockReturnValue(tempDir);
    vi.mocked(resolveApiKey).mockResolvedValue({
      apiKey: undefined,
      source: 'none',
      useNativeAuth: true,
    });
  });

  afterEach(async () => {
    process.env.PATH = originalPath;
    process.env.HOME = originalHome;
    vi.restoreAllMocks();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('keeps device auth, status probing, and disconnect isolated per user', async () => {
    const config = {};
    const deviceAuthManager = new CodexDeviceAuthManager();
    const statusManager = new CodexAuthStatusManager({} as never, config);

    const flowA = await deviceAuthManager.start(config, { agorUserId: 'user-a' });
    const flowB = await deviceAuthManager.start(config, { agorUserId: 'user-b' });

    expect(flowA.codexHome).toContain('/.agor/codex/users/user-a');
    expect(flowB.codexHome).toContain('/.agor/codex/users/user-b');
    expect(flowA.codexHome).not.toBe(flowB.codexHome);
    expect(flowA.verificationUri).toBe('https://chatgpt.com/device');
    expect(flowB.verificationUri).toBe('https://chatgpt.com/device');
    expect(flowA.userCode).not.toBe(flowB.userCode);

    await waitFor(() => deviceAuthManager.get(flowA.flowId)?.status === 'completed');
    await waitFor(() => deviceAuthManager.get(flowB.flowId)?.status === 'completed');

    const authJsonAPath = path.join(flowA.codexHome, 'auth.json');
    const authJsonBPath = path.join(flowB.codexHome, 'auth.json');
    const authJsonA = JSON.parse(await fs.readFile(authJsonAPath, 'utf8'));
    const authJsonB = JSON.parse(await fs.readFile(authJsonBPath, 'utf8'));

    expect(authJsonA).toMatchObject({ access_token: 'token-user-a', userId: 'user-a' });
    expect(authJsonB).toMatchObject({ access_token: 'token-user-b', userId: 'user-b' });

    const statusA = await statusManager.getStatusForUser('user-a');
    const statusB = await statusManager.getStatusForUser('user-b');

    expect(statusA).toMatchObject({
      agorUserId: 'user-a',
      status: 'signed_in_with_chatgpt',
      codexHome: flowA.codexHome,
    });
    expect(statusB).toMatchObject({
      agorUserId: 'user-b',
      status: 'signed_in_with_chatgpt',
      codexHome: flowB.codexHome,
    });

    await statusManager.disconnectUser('user-a');

    await expect(fs.access(authJsonAPath)).rejects.toThrow();
    await expect(fs.readFile(authJsonBPath, 'utf8')).resolves.toContain('token-user-b');

    const statusAAfterDisconnect = await statusManager.getStatusForUser('user-a');
    const statusBAfterDisconnect = await statusManager.getStatusForUser('user-b');

    expect(statusAAfterDisconnect.status).toBe('not_signed_in');
    expect(statusBAfterDisconnect.status).toBe('signed_in_with_chatgpt');
  });
});
