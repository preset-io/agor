/**
 * Starting a daemon is what service managers, containers and provisioning scripts
 * do, so `agor daemon start` must never block on a prompt and must never rewrite
 * config.yaml as a side effect. It used to do both: a missing `daemon.deployment_id`
 * dropped it into an inquirer confirm that offered to rewrite the file.
 *
 * The interactive repair now lives in `agor doctor`. These tests pin the split.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('inquirer', () => ({ default: { prompt: vi.fn() } }));
vi.mock('@agor/core/config', () => ({
  getConfigPath: vi.fn(() => '/tmp/agor-test/config.yaml'),
  loadConfig: vi.fn(),
  loadConfigFromFile: vi.fn(),
  migrateConfigDeploymentId: vi.fn(),
  requireDeploymentId: vi.fn(),
}));

import { loadConfig, migrateConfigDeploymentId, requireDeploymentId } from '@agor/core/config';
import inquirer from 'inquirer';
import {
  describeMissingDeploymentId,
  isMissingDeploymentIdError,
  loadDaemonConfigWithDeploymentIdentity,
  repairDeploymentId,
} from './daemon-deployment-config';

const MISSING = new Error("Config validation failed: 'daemon.deployment_id' is required");
const DEPLOYMENT_ID = '019c1234-5678-7123-8123-123456789abc';

/** `isTTY` is absent under vitest, so it has to be defined rather than spied on. */
function setTty(streams: { stdin: boolean; stdout: boolean }): () => void {
  const original = { stdin: process.stdin.isTTY, stdout: process.stdout.isTTY };
  Object.defineProperty(process.stdin, 'isTTY', { value: streams.stdin, configurable: true });
  Object.defineProperty(process.stdout, 'isTTY', { value: streams.stdout, configurable: true });
  return () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: original.stdin, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: original.stdout, configurable: true });
  };
}

describe('loadDaemonConfigWithDeploymentIdentity', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(loadConfig).mockResolvedValue({ daemon: {} } as never);
  });

  afterEach(() => vi.restoreAllMocks());

  it('returns the config when a deployment ID is present', async () => {
    vi.mocked(requireDeploymentId).mockReturnValue(undefined as never);

    const result = await loadDaemonConfigWithDeploymentIdentity();

    expect(result.config).toEqual({ daemon: {} });
    expect(inquirer.prompt).not.toHaveBeenCalled();
  });

  it('fails without prompting when the deployment ID is missing', async () => {
    vi.mocked(requireDeploymentId).mockImplementation(() => {
      throw MISSING;
    });

    await expect(loadDaemonConfigWithDeploymentIdentity()).rejects.toThrow(
      /daemon\.deployment_id is missing/
    );
    expect(inquirer.prompt).not.toHaveBeenCalled();
    expect(migrateConfigDeploymentId).not.toHaveBeenCalled();
  });

  it('points at agor doctor rather than leaving the operator to guess', async () => {
    vi.mocked(requireDeploymentId).mockImplementation(() => {
      throw MISSING;
    });

    await expect(loadDaemonConfigWithDeploymentIdentity()).rejects.toThrow(/agor doctor/);
  });

  it('rethrows unrelated config errors untouched', async () => {
    vi.mocked(requireDeploymentId).mockImplementation(() => {
      throw new Error('daemon.port must be a number');
    });

    await expect(loadDaemonConfigWithDeploymentIdentity()).rejects.toThrow(
      'daemon.port must be a number'
    );
  });
});

describe('describeMissingDeploymentId', () => {
  it('warns that a fresh ID re-identifies the deployment', () => {
    const message = describeMissingDeploymentId('/etc/agor/config.yaml');

    expect(message).toContain('/etc/agor/config.yaml');
    expect(message).toContain('agor doctor');
    expect(message).toMatch(/restore that exact value/);
  });
});

describe('isMissingDeploymentIdError', () => {
  it('recognizes only the missing-deployment-id failure', () => {
    expect(isMissingDeploymentIdError(MISSING)).toBe(true);
    expect(isMissingDeploymentIdError(new Error('something else'))).toBe(false);
  });
});

describe('repairDeploymentId', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(loadConfig).mockResolvedValue({ daemon: {} } as never);
  });

  it('does nothing when the deployment ID is already set', async () => {
    vi.mocked(requireDeploymentId).mockReturnValue(undefined as never);

    await expect(repairDeploymentId()).resolves.toBeNull();
    expect(inquirer.prompt).not.toHaveBeenCalled();
  });

  it('writes the operator-supplied ID after confirmation', async () => {
    vi.mocked(requireDeploymentId).mockImplementation(() => {
      throw MISSING;
    });
    const restoreTty = setTty({ stdin: true, stdout: true });
    vi.mocked(inquirer.prompt)
      .mockResolvedValueOnce({ deploymentId: DEPLOYMENT_ID } as never)
      .mockResolvedValueOnce({ rewrite: true } as never);
    vi.mocked(migrateConfigDeploymentId).mockResolvedValue({
      config: {},
      deploymentId: DEPLOYMENT_ID,
      backupPath: '/tmp/agor-test/config.yaml.backup',
    } as never);

    const result = await repairDeploymentId();

    expect(result).toEqual({
      deploymentId: DEPLOYMENT_ID,
      backupPath: '/tmp/agor-test/config.yaml.backup',
    });
    // The operator's own ID, not a freshly minted one — restoring a deployment's
    // previous identity is the whole point of accepting input here.
    expect(migrateConfigDeploymentId).toHaveBeenCalledWith(expect.any(String), DEPLOYMENT_ID);
    restoreTty();
  });

  it('writes nothing when the operator declines', async () => {
    vi.mocked(requireDeploymentId).mockImplementation(() => {
      throw MISSING;
    });
    const restoreTty = setTty({ stdin: true, stdout: true });
    vi.mocked(inquirer.prompt)
      .mockResolvedValueOnce({ deploymentId: DEPLOYMENT_ID } as never)
      .mockResolvedValueOnce({ rewrite: false } as never);

    await expect(repairDeploymentId()).resolves.toBeNull();
    expect(migrateConfigDeploymentId).not.toHaveBeenCalled();
    restoreTty();
  });

  it('refuses to prompt when there is no terminal', async () => {
    vi.mocked(requireDeploymentId).mockImplementation(() => {
      throw MISSING;
    });
    const restoreTty = setTty({ stdin: false, stdout: false });

    await expect(repairDeploymentId()).rejects.toThrow(/daemon\.deployment_id is missing/);
    expect(inquirer.prompt).not.toHaveBeenCalled();
    restoreTty();
  });
});
