import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs/promises', () => ({ access: vi.fn() }));
vi.mock('./auth.js', () => ({ loadToken: vi.fn() }));
vi.mock('@agor/core/config', () => ({
  getConfigPath: vi.fn(() => '/home/test/.agor/config.yaml'),
  loadConfig: vi.fn(),
  requireDeploymentId: vi.fn(),
  resolveDaemonUrl: vi.fn(),
}));

import { access } from 'node:fs/promises';
import {
  getConfigPath,
  loadConfig,
  requireDeploymentId,
  resolveDaemonUrl,
} from '@agor/core/config';
import { loadToken } from './auth.js';
import {
  resolveConnectedDeploymentTarget,
  resolveLocalDeploymentTarget,
} from './deployment-target';

const deploymentId = '019c1234-5678-7123-8123-123456789abc';

describe('deployment target resolution', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv('AGOR_API_KEY', '');
    vi.stubEnv('AGOR_DEPLOYMENT_ID', '');
    vi.stubEnv('DAEMON_URL', '');
    vi.mocked(access).mockResolvedValue(undefined);
  });

  afterEach(() => vi.unstubAllEnvs());

  it('uses the one stored login target', async () => {
    vi.mocked(loadToken).mockResolvedValue({
      version: 2,
      target: {
        url: 'https://agor.example.com/base',
        origin: 'https://agor.example.com',
        deploymentId,
      },
      accessToken: 'secret',
      user: { user_id: 'u1', email: 'max@example.com', role: 'admin' },
      expiresAt: Date.now() + 1000,
    });

    await expect(resolveConnectedDeploymentTarget()).resolves.toMatchObject({
      url: 'https://agor.example.com/base',
      deploymentId,
      source: 'login',
    });
  });

  it('gives a complete API-key environment target precedence and normalizes it', async () => {
    vi.stubEnv('AGOR_API_KEY', 'agor_sk_test');
    vi.stubEnv('AGOR_DEPLOYMENT_ID', deploymentId);
    vi.stubEnv('DAEMON_URL', 'https://agor.example.com/base/');

    await expect(resolveConnectedDeploymentTarget()).resolves.toEqual({
      url: 'https://agor.example.com/base',
      deploymentId,
      source: 'environment',
    });
    expect(loadToken).not.toHaveBeenCalled();
  });

  it('rejects an incomplete API-key environment instead of falling back', async () => {
    vi.stubEnv('AGOR_API_KEY', 'agor_sk_test');
    vi.stubEnv('DAEMON_URL', 'https://agor.example.com');

    await expect(resolveConnectedDeploymentTarget()).rejects.toThrow('AGOR_DEPLOYMENT_ID');
  });

  it('resolves the local target only through effective config utilities', async () => {
    const config = { daemon: { deployment_id: deploymentId } };
    vi.mocked(loadConfig).mockResolvedValue(config);
    vi.mocked(resolveDaemonUrl).mockReturnValue('http://127.0.0.1:4040');
    vi.mocked(requireDeploymentId).mockReturnValue(deploymentId);

    await expect(resolveLocalDeploymentTarget()).resolves.toEqual({
      url: 'http://127.0.0.1:4040',
      deploymentId,
      source: 'local',
    });
    expect(resolveDaemonUrl).toHaveBeenCalledWith(config);
    expect(requireDeploymentId).toHaveBeenCalledWith(config);
  });

  it('reports a missing local config without loading defaults', async () => {
    vi.mocked(access).mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }));

    await expect(resolveLocalDeploymentTarget()).rejects.toThrow(
      'No local config found at /home/test/.agor/config.yaml. Run agor init.'
    );
    expect(getConfigPath).toHaveBeenCalled();
    expect(loadConfig).not.toHaveBeenCalled();
  });

  it('preserves invalid local config errors', async () => {
    vi.mocked(loadConfig).mockRejectedValue(new Error('Config error: invalid YAML'));

    await expect(resolveLocalDeploymentTarget()).rejects.toThrow('Config error: invalid YAML');
  });

  it('preserves non-missing config access errors', async () => {
    vi.mocked(access).mockRejectedValue(
      Object.assign(new Error('permission denied'), { code: 'EACCES' })
    );

    await expect(resolveLocalDeploymentTarget()).rejects.toThrow('permission denied');
    expect(loadConfig).not.toHaveBeenCalled();
  });
});
