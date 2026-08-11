import type { AgorConfig } from '@agor/core/config';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveMasterSecretIntoEnv } from './master-secret.js';

/**
 * Regression coverage for the boot ordering bug: on PostgreSQL,
 * MCPOAuthPendingFlowAuthority is constructed during registerServices() and
 * reads process.env.AGOR_MASTER_SECRET in its constructor. A deployment that
 * keeps the master secret in config.yaml (daemon.masterSecret) rather than an
 * env var must still have it promoted onto process.env BEFORE service
 * registration. This helper is the promotion step; index.ts calls it before
 * Phase 1.
 */
describe('resolveMasterSecretIntoEnv', () => {
  const SECRET_64 = 'a'.repeat(64);
  let original: string | undefined;

  beforeEach(() => {
    original = process.env.AGOR_MASTER_SECRET;
    delete process.env.AGOR_MASTER_SECRET;
  });

  afterEach(() => {
    if (original === undefined) delete process.env.AGOR_MASTER_SECRET;
    else process.env.AGOR_MASTER_SECRET = original;
  });

  it('promotes a config-only master secret onto process.env (the previously-broken Postgres path)', async () => {
    const config = { daemon: { masterSecret: SECRET_64 } } as AgorConfig;

    const source = await resolveMasterSecretIntoEnv(config);

    expect(source).toBe('config');
    expect(process.env.AGOR_MASTER_SECRET).toBe(SECRET_64);
  });

  it('prefers the env var over the config value when both are present', async () => {
    process.env.AGOR_MASTER_SECRET = 'b'.repeat(64);
    const config = { daemon: { masterSecret: SECRET_64 } } as AgorConfig;

    const source = await resolveMasterSecretIntoEnv(config);

    expect(source).toBe('env');
    expect(process.env.AGOR_MASTER_SECRET).toBe('b'.repeat(64));
  });

  it('fail-fasts when neither the env var nor daemon.masterSecret is configured', async () => {
    const config = { daemon: {} } as AgorConfig;

    await expect(resolveMasterSecretIntoEnv(config)).rejects.toThrow(/AGOR_MASTER_SECRET/);
    expect(process.env.AGOR_MASTER_SECRET).toBeUndefined();
  });
});
