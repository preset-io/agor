import {
  type AgorConfig,
  type ResolvedDeploymentConfig,
  resolveDeploymentConfig,
} from '@agor/core/config';
import { describe, expect, it } from 'vitest';
import { resolveWebTerminalCapability } from './terminal-capability';

const standalone = { mode: 'standalone' } as const satisfies ResolvedDeploymentConfig;
const sharedLocalHa = {
  mode: 'ha',
  topology: {
    execution: 'shared-local',
    sharedFilesystem: true,
    ingressAffinity: true,
  },
} as ResolvedDeploymentConfig;
const externalHa = {
  mode: 'ha',
  topology: {
    execution: 'external',
    sharedFilesystem: false,
    ingressAffinity: true,
  },
} as ResolvedDeploymentConfig;

describe('resolveWebTerminalCapability', () => {
  it('supports owner-local standalone and shared-local HA runtimes', () => {
    expect(
      resolveWebTerminalCapability({ config: {} as AgorConfig, deployment: standalone })
    ).toMatchObject({
      enabled: true,
      mode: 'owner-local-ephemeral',
    });
    expect(
      resolveWebTerminalCapability({ config: {} as AgorConfig, deployment: sharedLocalHa })
    ).toMatchObject({ enabled: true, mode: 'owner-local-ephemeral' });
  });

  it('uses the resolved deployment topology when HA settings come only from env', () => {
    const config = {
      database: { dialect: 'postgresql' },
      deployment: { redis: { url: 'redis://stale.invalid:6379', key_prefix: 'stale' } },
      execution: {
        allow_web_terminal: true,
        managed_envs_execution_mode: 'webhook-only',
        executor_storage: {
          user_home: 'shared',
          branch_workspace: 'shared',
          base_repository: 'shared',
        },
      },
    } as AgorConfig;
    const deployment = resolveDeploymentConfig(config, {
      AGOR_DEPLOYMENT_MODE: 'ha',
      AGOR_HA_SUPPORT_PROFILE: 'constrained-active-active',
      AGOR_HA_EXECUTION_TOPOLOGY: 'shared-local',
      AGOR_HA_SHARED_FILESYSTEM: 'true',
      AGOR_HA_INGRESS_AFFINITY: 'true',
      AGOR_JWT_SECRET: 'j'.repeat(32),
      AGOR_MASTER_SECRET: 'm'.repeat(32),
      AGOR_ADMIN_PASSWORD: 'bootstrap-admin-password',
      REDIS_URL: 'redis://redis.internal:6379',
      AGOR_REDIS_KEY_PREFIX: 'env-only-ha',
    });

    expect(resolveWebTerminalCapability({ config, deployment })).toMatchObject({
      enabled: true,
      mode: 'owner-local-ephemeral',
    });
  });

  it('fails closed for operator-disabled and unowned external runtimes', () => {
    expect(
      resolveWebTerminalCapability({
        config: { execution: { allow_web_terminal: false } } as AgorConfig,
        deployment: standalone,
      })
    ).toMatchObject({ enabled: false, reason: 'operator-disabled' });
    expect(
      resolveWebTerminalCapability({
        config: {
          execution: { executor_command_template: 'kubectl create -f -' },
        } as AgorConfig,
        deployment: standalone,
      })
    ).toMatchObject({ enabled: false, reason: 'external-runtime-unowned' });
    expect(
      resolveWebTerminalCapability({ config: {} as AgorConfig, deployment: externalHa })
    ).toMatchObject({ enabled: false, reason: 'unsupported-ha-topology' });
  });
});
