/**
 * Tests for the capability-driven secret resolver shared by JWT secret and
 * AGOR_MASTER_SECRET bootstrap. See `setup/persisted-secret.ts` and
 * context/explorations/daemon-fs-decoupling.md §1.5 (H3).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolvePersistedSecret } from './persisted-secret.js';

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
  });

  it('prefers the env var when present (no disk touch)', async () => {
    process.env[ENV_VAR] = 'from-env';
    const result = await resolvePersistedSecret({
      name: 'test',
      envVar: ENV_VAR,
      existing: 'from-config-should-be-ignored',
      configKey: CONFIG_KEY,
    });

    expect(result).toEqual({ value: 'from-env', source: 'env' });
  });

  it('falls back to the existing persisted value when no env var', async () => {
    const result = await resolvePersistedSecret({
      name: 'test',
      envVar: ENV_VAR,
      existing: 'from-config',
      configKey: CONFIG_KEY,
    });

    expect(result).toEqual({ value: 'from-config', source: 'config' });
  });

  it('fails fast without generating or writing when neither source is configured', async () => {
    await expect(
      resolvePersistedSecret({
        name: 'JWT secret',
        envVar: ENV_VAR,
        existing: undefined,
        configKey: CONFIG_KEY,
      })
    ).rejects.toThrow(/JWT secret.*required.*neither.*configured/s);

    // The error message MUST name both escape hatches so on-call doesn't
    // have to read code to recover.
    await expect(
      resolvePersistedSecret({
        name: 'JWT secret',
        envVar: ENV_VAR,
        existing: undefined,
        configKey: CONFIG_KEY,
      })
    ).rejects.toThrow(new RegExp(`${ENV_VAR}.*config\\.yaml`, 's'));
  });
});
