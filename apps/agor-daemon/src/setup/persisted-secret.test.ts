/**
 * Tests for the capability-driven secret resolver shared by JWT secret and
 * AGOR_MASTER_SECRET bootstrap. See `setup/persisted-secret.ts` and
 * context/explorations/daemon-fs-decoupling.md §1.5 (H3).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolvePersistedSecret } from './persisted-secret.js';

// Mock the core config writer. The helper's whole point is to centralize the
// "try to persist, fail-fast with clear remediation" pattern; we want to drive
// `setConfigValue` success/failure from the test, not actually hit disk.
vi.mock('@agor/core/config', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    setConfigValue: vi.fn(),
  };
});

async function getMockedSetConfigValue(): Promise<ReturnType<typeof vi.fn>> {
  const mod = (await import('@agor/core/config')) as unknown as {
    setConfigValue: ReturnType<typeof vi.fn>;
  };
  return mod.setConfigValue;
}

const ENV_VAR = 'TEST_SECRET_FOR_PERSISTED_SECRET';
const CONFIG_KEY = 'daemon.testSecret';

describe('resolvePersistedSecret', () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env[ENV_VAR];
    delete process.env[ENV_VAR];
  });

  afterEach(async () => {
    if (originalEnv === undefined) {
      delete process.env[ENV_VAR];
    } else {
      process.env[ENV_VAR] = originalEnv;
    }
    vi.clearAllMocks();
  });

  it('prefers the env var when present (no disk touch)', async () => {
    process.env[ENV_VAR] = 'from-env';
    const setConfigValue = await getMockedSetConfigValue();

    const result = await resolvePersistedSecret({
      name: 'test',
      envVar: ENV_VAR,
      existing: 'from-config-should-be-ignored',
      configKey: CONFIG_KEY,
      generate: () => 'should-not-be-called',
    });

    expect(result).toEqual({ value: 'from-env', source: 'env' });
    expect(setConfigValue).not.toHaveBeenCalled();
  });

  it('falls back to the existing persisted value when no env var', async () => {
    const setConfigValue = await getMockedSetConfigValue();

    const result = await resolvePersistedSecret({
      name: 'test',
      envVar: ENV_VAR,
      existing: 'from-config',
      configKey: CONFIG_KEY,
      generate: () => 'should-not-be-called',
    });

    expect(result).toEqual({ value: 'from-config', source: 'config' });
    expect(setConfigValue).not.toHaveBeenCalled();
  });

  it('generates + persists when neither env nor existing is set', async () => {
    const setConfigValue = await getMockedSetConfigValue();
    setConfigValue.mockResolvedValue(undefined);

    const result = await resolvePersistedSecret({
      name: 'test',
      envVar: ENV_VAR,
      existing: undefined,
      configKey: CONFIG_KEY,
      generate: () => 'fresh-generated-value',
    });

    expect(result).toEqual({ value: 'fresh-generated-value', source: 'generated' });
    expect(setConfigValue).toHaveBeenCalledWith(CONFIG_KEY, 'fresh-generated-value');
  });

  it('fails fast with an actionable error when nothing is set AND persist fails', async () => {
    const setConfigValue = await getMockedSetConfigValue();
    setConfigValue.mockRejectedValue(new Error('EROFS: read-only file system'));

    await expect(
      resolvePersistedSecret({
        name: 'JWT secret',
        envVar: ENV_VAR,
        existing: undefined,
        configKey: CONFIG_KEY,
        generate: () => 'fresh',
      })
    ).rejects.toThrow(/JWT secret.*not writable/s);

    // The error message MUST name both escape hatches so on-call doesn't
    // have to read code to recover.
    await expect(
      resolvePersistedSecret({
        name: 'JWT secret',
        envVar: ENV_VAR,
        existing: undefined,
        configKey: CONFIG_KEY,
        generate: () => 'fresh',
      })
    ).rejects.toThrow(new RegExp(`${ENV_VAR}.*config\\.yaml`, 's'));
  });
});
