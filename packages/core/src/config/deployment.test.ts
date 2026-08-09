import { describe, expect, it } from 'vitest';
import { resolveDeploymentConfig, validateRedisKeyPrefix, validateRedisUrl } from './deployment';
import type { AgorConfig } from './types';

const secrets = {
  AGOR_JWT_SECRET: 'j'.repeat(32),
  AGOR_MASTER_SECRET: 'm'.repeat(32),
};

const haConfig: AgorConfig = {
  deployment: {
    mode: 'ha',
    redis: { url: 'rediss://redis.internal:6380/2', key_prefix: 'prod-blue' },
    ha: {
      support_profile: 'constrained-active-active',
      execution_topology: 'shared-local',
      shared_filesystem: true,
      ingress_affinity: true,
    },
  },
  database: { dialect: 'postgresql' },
  execution: {
    allow_web_terminal: false,
    managed_envs_execution_mode: 'webhook-only',
    executor_storage: {
      user_home: 'shared',
      branch_workspace: 'shared',
      base_repository: 'shared',
    },
  },
};

describe('resolveDeploymentConfig', () => {
  it('keeps standalone as the default even when REDIS_URL exists', () => {
    expect(resolveDeploymentConfig({}, { REDIS_URL: 'redis://ignored:6379' })).toEqual({
      mode: 'standalone',
    });
  });

  it('resolves explicit HA with TLS Redis, bounded backoff, and explicit assertions', () => {
    expect(resolveDeploymentConfig(haConfig, secrets)).toMatchObject({
      mode: 'ha',
      supportProfile: 'constrained-active-active',
      capabilities: {
        taskExecution: true,
        executorTokenAuthority: true,
        interactivePermissions: false,
        gatewayListeners: true,
        gatewayOutboundExactlyOnce: false,
        environmentHealthMonitor: false,
        statelessMcp: true,
        statefulMcp: false,
        completionCallbackDurableAdmission: true,
        completionCallbackPreAdmissionRecovery: false,
        widgetResolutionDurableClaim: true,
        codexCredentialFiles: true,
        codexDeviceAuth: false,
      },
      redis: {
        url: 'rediss://redis.internal:6380/2',
        keyPrefix: 'prod-blue',
        reconnectBaseDelayMs: 100,
        reconnectMaxDelayMs: 2000,
      },
      executorStorage: {
        userHome: 'shared',
        branchWorkspace: 'shared',
        baseRepository: 'shared',
      },
    });
  });

  it('accepts the constrained support profile from the environment override', () => {
    const config = {
      ...haConfig,
      deployment: {
        ...haConfig.deployment,
        ha: {
          execution_topology: 'shared-local',
          shared_filesystem: true,
          ingress_affinity: true,
        },
      },
    } as AgorConfig;
    expect(
      resolveDeploymentConfig(config, {
        ...secrets,
        AGOR_HA_SUPPORT_PROFILE: 'constrained-active-active',
      })
    ).toMatchObject({ mode: 'ha', supportProfile: 'constrained-active-active' });
  });

  it.each([
    [
      {
        ...haConfig,
        deployment: {
          ...haConfig.deployment,
          ha: {
            execution_topology: 'shared-local',
            shared_filesystem: true,
            ingress_affinity: true,
          },
        },
      },
      secrets,
      'support_profile',
    ],
    [{ ...haConfig, database: { dialect: 'sqlite' } }, secrets, 'requires PostgreSQL'],
    [haConfig, { ...secrets, AGOR_JWT_SECRET: undefined }, 'AGOR_JWT_SECRET'],
    [haConfig, { ...secrets, AGOR_MASTER_SECRET: undefined }, 'AGOR_MASTER_SECRET'],
    [
      {
        ...haConfig,
        execution: { allow_web_terminal: true, managed_envs_execution_mode: 'webhook-only' },
      },
      secrets,
      'allow_web_terminal',
    ],
  ] as const)('fails unsafe HA config: %s', (config, env, message) => {
    expect(() => resolveDeploymentConfig(config, env)).toThrow(message);
  });

  it('fails closed when requested PostgreSQL does not match the daemon runtime URL', () => {
    expect(() => resolveDeploymentConfig(haConfig, secrets, 'file:/tmp/agor.db')).toThrow(
      /runtime database.*PostgreSQL/
    );
  });

  it('rejects an inverted reconnect window', () => {
    expect(() =>
      resolveDeploymentConfig(
        {
          ...haConfig,
          deployment: {
            ...haConfig.deployment,
            redis: {
              ...haConfig.deployment?.redis,
              reconnect_base_delay_ms: 500,
              reconnect_max_delay_ms: 100,
            },
          },
        },
        secrets
      )
    ).toThrow('maximum reconnect delay');
  });

  it('supports an external executor topology without a daemon workspace mount', () => {
    const external = {
      ...haConfig,
      deployment: {
        ...haConfig.deployment,
        ha: {
          support_profile: 'constrained-active-active',
          execution_topology: 'external',
          ingress_affinity: true,
        },
      },
      execution: {
        ...haConfig.execution,
        executor_command_template: 'cell launch --tenant {tenant_id} -- {command}',
        executor_storage: {
          user_home: 'persistent-per-user',
          branch_workspace: 'persistent-per-branch',
          base_repository: 'unavailable',
        },
        branch_storage: {
          default_mode: 'clone',
          allowed_modes: ['clone'],
          allow_shallow_clones: false,
        },
      },
      daemon: { public_url: 'https://agor.internal.example' },
    } as AgorConfig;

    expect(resolveDeploymentConfig(external, secrets)).toMatchObject({
      topology: { execution: 'external', sharedFilesystem: false },
      executorStorage: {
        userHome: 'persistent-per-user',
        branchWorkspace: 'persistent-per-branch',
        baseRepository: 'unavailable',
      },
    });
  });

  it('rejects HA when the executor storage contract is omitted', () => {
    const config = {
      ...haConfig,
      execution: {
        allow_web_terminal: false,
        managed_envs_execution_mode: 'webhook-only',
      },
    } as AgorConfig;
    expect(() => resolveDeploymentConfig(config, secrets)).toThrow('executor_storage');
  });

  it('rejects a missing base repository while worktrees remain enabled', () => {
    const config = {
      ...haConfig,
      execution: {
        ...haConfig.execution,
        executor_storage: {
          user_home: 'shared',
          branch_workspace: 'shared',
          base_repository: 'unavailable',
        },
      },
    } as AgorConfig;
    expect(() => resolveDeploymentConfig(config, secrets)).toThrow('clone-only');
  });

  it('allows explicit false environment assertions to override file booleans', () => {
    const external = {
      ...haConfig,
      execution: {
        ...haConfig.execution,
        executor_command_template: 'cell launch --tenant {tenant_id} -- {command}',
      },
      daemon: { public_url: 'https://agor.internal.example' },
    } as AgorConfig;
    expect(
      resolveDeploymentConfig(external, {
        ...secrets,
        AGOR_HA_EXECUTION_TOPOLOGY: 'external',
        AGOR_HA_SHARED_FILESYSTEM: 'false',
      })
    ).toMatchObject({ topology: { execution: 'external', sharedFilesystem: false } });
  });

  it('rejects external execution without a fleet-reachable daemon callback URL', () => {
    expect(() =>
      resolveDeploymentConfig(
        {
          ...haConfig,
          deployment: {
            ...haConfig.deployment,
            ha: {
              support_profile: 'constrained-active-active',
              execution_topology: 'external',
              ingress_affinity: true,
            },
          },
          execution: {
            ...haConfig.execution,
            executor_command_template: 'cell launch --tenant {tenant_id} -- {command}',
          },
        },
        secrets
      )
    ).toThrow('daemon.public_url');
  });

  it.each([
    'https://user:secret@agor.internal.example',
    'https://agor.internal.example?token=secret',
    'https://agor.internal.example#fragment',
  ])('rejects credential-bearing or ambiguous external callback URL %s', (publicUrl) => {
    expect(() =>
      resolveDeploymentConfig(
        {
          ...haConfig,
          deployment: {
            ...haConfig.deployment,
            ha: {
              support_profile: 'constrained-active-active',
              execution_topology: 'external',
              ingress_affinity: true,
            },
          },
          execution: {
            ...haConfig.execution,
            executor_command_template: 'cell launch --tenant {tenant_id} -- {command}',
          },
          daemon: { public_url: publicUrl },
        },
        secrets
      )
    ).toThrow('credential-free');
  });

  it('rejects non-boolean topology environment values', () => {
    expect(() =>
      resolveDeploymentConfig(haConfig, {
        ...secrets,
        AGOR_HA_INGRESS_AFFINITY: 'yes',
      })
    ).toThrow('AGOR_HA_INGRESS_AFFINITY must be true or false');
  });
});

describe('Redis configuration validation', () => {
  it.each(['redis://localhost:6379', 'rediss://user:secret@redis.example/0'])('accepts %s', (url) =>
    expect(validateRedisUrl(url)).toBe(url)
  );

  it.each(['http://redis.example', 'redis://', 'redis://redis.example/not-a-db'])(
    'rejects %s',
    (url) => expect(() => validateRedisUrl(url)).toThrow('Config error')
  );

  it('rejects namespaces that could collide with Redis key syntax', () => {
    expect(() => validateRedisKeyPrefix('tenant:a')).toThrow('key_prefix');
  });
});
