import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertValidEffectiveExecutionConfig,
  loadConfigFromFile,
  resolveEffectiveConfig,
} from './config-manager';
import { resolveDeploymentConfig } from './deployment';
import { resolveIdentityAuthority } from './identity-authority';
import { assertValidMultiTenancyConfig } from './multitenancy';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true }))
  );
});

describe('checked-in HA Compose configuration', () => {
  it('materializes into a valid auth-resolved multi-tenant HA profile', async () => {
    const source = await fs.readFile(path.join(REPO_ROOT, 'docker/ha/config.yaml'), 'utf8');
    expect(source).toContain('__AGOR_HA_PUBLIC_ORIGIN__');
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agor-ha-config-'));
    temporaryDirectories.push(directory);
    const configPath = path.join(directory, 'config.yaml');
    await fs.writeFile(
      configPath,
      source.replaceAll('__AGOR_HA_PUBLIC_ORIGIN__', 'http://127.0.0.1:3030')
    );

    const raw = await loadConfigFromFile(configPath);
    const environment = {
      AGOR_DB_DIALECT: 'postgresql',
      DATABASE_URL: 'postgresql://agor_app:test@postgres:5432/agor',
      REDIS_URL: 'redis://redis:6379/0',
      AGOR_REDIS_KEY_PREFIX: 'agor-ha-config-test',
      AGOR_JWT_SECRET: 'agor-ha-config-test-jwt-secret-00000000000000',
      AGOR_MASTER_SECRET: 'agor-ha-config-test-master-secret-00000000000',
      AGOR_EXTERNAL_LAUNCH_SHARED_SECRET: 'agor-ha-config-test-launch-secret-00000000000',
      AGOR_DEPLOYMENT_MODE: 'ha',
      AGOR_HA_SUPPORT_PROFILE: 'constrained-active-active',
      AGOR_HA_EXECUTION_TOPOLOGY: 'shared-local',
      AGOR_HA_SHARED_FILESYSTEM: 'true',
      AGOR_HA_INGRESS_AFFINITY: 'true',
    } satisfies NodeJS.ProcessEnv;
    const effective = resolveEffectiveConfig(raw, environment);

    assertValidMultiTenancyConfig(effective);
    assertValidEffectiveExecutionConfig(effective);
    expect(resolveDeploymentConfig(effective, environment, environment.DATABASE_URL)).toMatchObject(
      {
        mode: 'ha',
        topology: { execution: 'shared-local' },
        executorStorage: { userHome: 'persistent-per-user' },
      }
    );
    expect(effective.multi_tenancy).toMatchObject({
      mode: 'required_from_auth',
      auth_claim: 'tenant_id',
      filesystem_isolation_enabled: true,
    });
    expect(effective.execution).toMatchObject({
      branch_rbac: true,
      unix_user_mode: 'sandbox',
      sandbox: { enabled: true, home_mode: 'per_user', fail_if_unavailable: true },
    });
    expect(effective.external_launch).toMatchObject({
      enabled: true,
      exchange_url: 'http://dev-launcher:4000/exchange',
      login_redirect_url: 'http://127.0.0.1:3030/dev-auth/',
      dev_shared_secret: environment.AGOR_EXTERNAL_LAUNCH_SHARED_SECRET,
    });
    expect(resolveIdentityAuthority(effective).capabilities.users.create).toBe(false);
  });
});
