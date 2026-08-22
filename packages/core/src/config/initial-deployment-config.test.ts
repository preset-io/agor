import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetConfigCacheForTests,
  createInitialConfig,
  getConfigPath,
  getDefaultConfig,
  loadConfig,
} from './config-manager.js';
import {
  ensureInitialDeploymentConfig,
  prepareInitialDeploymentConfig,
  requireBootableDeploymentConfig,
} from './initial-deployment-config.js';

describe('initial deployment config', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agor-initial-config-test-'));
    vi.spyOn(os, 'homedir').mockReturnValue(tempDir);
    __resetConfigCacheForTests();
  });

  afterEach(async () => {
    __resetConfigCacheForTests();
    await fs.rm(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('creates and reuses a complete bootable config with mode 0600', async () => {
    await fs.mkdir(path.dirname(getConfigPath()), { mode: 0o755 });
    const initial = prepareInitialDeploymentConfig(getDefaultConfig(), {
      deploymentId: '019c1234-5678-7123-8123-123456789abc',
    });
    const created = await ensureInitialDeploymentConfig(initial, {});

    expect(created).toMatchObject({
      created: true,
      deploymentId: '019c1234-5678-7123-8123-123456789abc',
    });
    expect(created.config.daemon?.jwtSecret).toMatch(/^[0-9a-f]{64}$/);
    expect(created.config.daemon?.masterSecret).toMatch(/^[0-9a-f]{64}$/);
    expect((await fs.stat(path.dirname(getConfigPath()))).mode & 0o777).toBe(0o700);
    expect((await fs.stat(getConfigPath())).mode & 0o777).toBe(0o600);

    const replacement = prepareInitialDeploymentConfig(getDefaultConfig(), {
      deploymentId: '019c1234-5678-7123-8123-123456789abd',
    });
    const reused = await ensureInitialDeploymentConfig(replacement, {});
    expect(reused).toMatchObject({
      created: false,
      deploymentId: created.deploymentId,
    });
    expect(reused.config).toEqual(created.config);
  });

  it('rejects an existing config that cannot boot the daemon', async () => {
    await createInitialConfig({
      daemon: { deployment_id: '019c1234-5678-7123-8123-123456789abc' },
    });
    const initial = prepareInitialDeploymentConfig(getDefaultConfig());
    await expect(ensureInitialDeploymentConfig(initial, {})).rejects.toThrow(/daemon\.jwtSecret/);
  });

  it('returns one complete winner to concurrent initializers', async () => {
    const first = prepareInitialDeploymentConfig(getDefaultConfig(), {
      deploymentId: '019c1234-5678-7123-8123-123456789abc',
    });
    const second = prepareInitialDeploymentConfig(getDefaultConfig(), {
      deploymentId: '019c1234-5678-7123-8123-123456789abd',
    });

    const results = await Promise.all([
      ensureInitialDeploymentConfig(first, {}),
      ensureInitialDeploymentConfig(second, {}),
    ]);
    expect(results.map((result) => result.created).sort()).toEqual([false, true]);
    expect(results[0].deploymentId).toBe(results[1].deploymentId);
    expect(requireBootableDeploymentConfig(await loadConfig(), {})).toBe(results[0].deploymentId);
  });
});
