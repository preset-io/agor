import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDefaultConfig, loadConfigSync } from './config';

describe('loadConfigSync', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agor-client-test-'));
    // homedir() reads $HOME on POSIX, so this keeps the suite off the host's
    // real ~/.agor/config.yaml.
    vi.stubEnv('HOME', tempDir);
    vi.stubEnv('AGOR_OUTER_SANDBOX', '');
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('returns defaults when no config file exists', () => {
    expect(loadConfigSync()).toEqual(getDefaultConfig());
  });

  it('fails loudly when the config file is unreadable', async () => {
    const agorDir = path.join(tempDir, '.agor');
    await fs.mkdir(agorDir, { recursive: true });
    const configPath = path.join(agorDir, 'config.yaml');
    await fs.mkdir(configPath);

    expect(() => loadConfigSync()).toThrow(/Failed to load config.*EISDIR/s);
  });

  // This loader backs getDaemonUrl() for every BaseCommand-derived CLI
  // command. Inside the executor sandbox the daemon config is masked, and
  // DAEMON_URL is injected precisely so this path is never reached — so
  // arriving here means the injection is what broke. Say that instead of
  // reporting a bare EACCES against a file the caller was never meant to read.
  it('explains the sandbox when the config is masked and DAEMON_URL is unset', async () => {
    const agorDir = path.join(tempDir, '.agor');
    await fs.mkdir(agorDir, { recursive: true });
    await fs.mkdir(path.join(agorDir, 'config.yaml'));
    vi.stubEnv('AGOR_OUTER_SANDBOX', '1');

    expect(() => loadConfigSync()).toThrow(
      /DAEMON_URL is unset.*masked by Agor's executor sandbox/s
    );
  });
});
