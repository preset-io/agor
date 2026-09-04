import { describe, expect, it } from 'vitest';
import { resolveDeploymentConfig, validateRedisKeyPrefix, validateRedisUrl } from './deployment';
import type { AgorConfig } from './types';

const secrets = {
  AGOR_JWT_SECRET: 'j'.repeat(32),
  AGOR_MASTER_SECRET: 'm'.repeat(32),
  AGOR_ADMIN_PASSWORD: 'bootstrap-admin-password',
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
      user_home_locking: 'cross-replica-flock',
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
        agorManagedInteractivePermissions: true,
        gatewayListeners: true,
        gatewayOutboundExactlyOnce: false,
        environmentHealthMonitor: true,
        statelessMcp: true,
        completionCallbackDurableAdmission: true,
        completionCallbackPreAdmissionRecovery: false,
        widgetResolutionDurableClaim: true,
        githubInstall: true,
        codexCredentialFiles: true,
        codexDeviceAuth: false,
        claudeAuth: false,
        claudeOAuth: false,
      },
      redis: {
        url: 'rediss://redis.internal:6380/2',
        keyPrefix: 'prod-blue',
        reconnectBaseDelayMs: 100,
        reconnectMaxDelayMs: 2000,
      },
      environmentHealthMonitor: {
        scanIntervalMs: 5000,
        httpTimeoutMs: 1000,
        claimLeaseMs: 15000,
      },
      executorStorage: {
        userHome: 'shared',
        userHomeLocking: 'cross-replica-flock',
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
    [haConfig, { ...secrets, AGOR_ADMIN_PASSWORD: undefined }, 'AGOR_ADMIN_PASSWORD'],
  ] as const)('fails unsafe HA config: %s', (config, env, message) => {
    expect(() => resolveDeploymentConfig(config, env)).toThrow(message);
  });

  it('allows owner-local ephemeral terminals in shared-local HA', () => {
    expect(() =>
      resolveDeploymentConfig(
        {
          ...haConfig,
          execution: { ...haConfig.execution, allow_web_terminal: true },
        },
        secrets
      )
    ).not.toThrow();
  });

  it('does not require a local admin password when external launch owns bootstrap', () => {
    expect(
      resolveDeploymentConfig(
        { ...haConfig, external_launch: { enabled: true } },
        { ...secrets, AGOR_ADMIN_PASSWORD: undefined }
      )
    ).toMatchObject({ mode: 'ha' });
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

  it('rejects an environment health lease without the required HTTP/write margin', () => {
    expect(() =>
      resolveDeploymentConfig(
        {
          ...haConfig,
          deployment: {
            ...haConfig.deployment,
            ha: {
              ...haConfig.deployment?.ha,
              environment_health_monitor: {
                http_timeout_ms: 10_000,
                claim_lease_ms: 14_999,
              },
            },
          },
        },
        secrets
      )
    ).toThrow('leave at least 5000ms');
  });

  it('rejects an environment health discovery page above the repository limit', () => {
    expect(() =>
      resolveDeploymentConfig(haConfig, {
        ...secrets,
        AGOR_HA_ENV_HEALTH_SCAN_BATCH_SIZE: '1001',
      })
    ).toThrow('scan batch size cannot exceed 1000');
  });

  it('allows disabling the distributed monitor startup offset through the environment', () => {
    const deployment = resolveDeploymentConfig(haConfig, {
      ...secrets,
      AGOR_HA_ENV_HEALTH_STARTUP_OFFSET_MAX_MS: '0',
    });
    expect(deployment.mode).toBe('ha');
    if (deployment.mode !== 'ha') throw new Error('Expected HA deployment');
    expect(deployment.environmentHealthMonitor.startupOffsetMaxMs).toBe(0);
  });

  it('does not tie a one-observation lease to the polling interval', () => {
    expect(() =>
      resolveDeploymentConfig(haConfig, {
        ...secrets,
        AGOR_HA_ENV_HEALTH_SCAN_INTERVAL_MS: '300000',
        AGOR_HA_ENV_HEALTH_MAX_IDLE_INTERVAL_MS: '300000',
        AGOR_HA_ENV_HEALTH_HTTP_TIMEOUT_MS: '1000',
        AGOR_HA_ENV_HEALTH_CLAIM_LEASE_MS: '6000',
      })
    ).not.toThrow();
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
        unix_user_mode: 'delegated',
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
      capabilities: { claudeAuth: false, claudeOAuth: false },
      executorStorage: {
        userHome: 'persistent-per-user',
        branchWorkspace: 'persistent-per-branch',
        baseRepository: 'unavailable',
      },
    });
  });

  it('supports hybrid managed environments only through the delegated HA executor path', () => {
    const externalHybrid = {
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
        unix_user_mode: 'delegated',
        managed_envs_execution_mode: 'hybrid',
        executor_command_template: 'cell launch --tenant {tenant_id} -- {command}',
        executor_response: {
          external_protocol: 'executor-response-v1',
          origin_url: 'https://agor-replica.internal.example',
        },
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

    expect(resolveDeploymentConfig(externalHybrid, secrets)).toMatchObject({
      topology: { execution: 'external', sharedFilesystem: false },
      executorStorage: {
        userHome: 'persistent-per-user',
        branchWorkspace: 'persistent-per-branch',
        baseRepository: 'unavailable',
      },
    });
  });

  it('does not weaken HA by allowing managed environment shell commands in daemon replicas', () => {
    expect(() =>
      resolveDeploymentConfig(
        {
          ...haConfig,
          execution: {
            ...haConfig.execution,
            managed_envs_execution_mode: 'hybrid',
          },
        },
        secrets
      )
    ).toThrow('execution_topology: external');
  });

  it('requires delegated identity and the authenticated response channel for HA hybrid mode', () => {
    const externalHybrid = {
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
        managed_envs_execution_mode: 'hybrid',
        executor_command_template: 'cell launch --tenant {tenant_id} -- {command}',
      },
      daemon: { public_url: 'https://agor.internal.example' },
    } as AgorConfig;

    expect(() => resolveDeploymentConfig(externalHybrid, secrets)).toThrow('unix_user_mode');
    expect(() =>
      resolveDeploymentConfig(
        {
          ...externalHybrid,
          execution: { ...externalHybrid.execution, unix_user_mode: 'delegated' },
        },
        secrets
      )
    ).toThrow('executor response support');
  });

  it('never advertises Claude containment through an external sandbox-labelled template', () => {
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
        unix_user_mode: 'sandbox',
        executor_command_template: 'cell launch --tenant {tenant_id} -- {command}',
        executor_storage: {
          user_home: 'persistent-per-user',
          user_home_locking: 'cross-replica-flock',
          branch_workspace: 'persistent-per-branch',
          base_repository: 'unavailable',
        },
        branch_storage: {
          default_mode: 'clone',
          allowed_modes: ['clone'],
          allow_shallow_clones: false,
        },
        sandbox: { enabled: true, home_mode: 'per_user' },
      },
      daemon: { public_url: 'https://agor.internal.example' },
    } as AgorConfig;

    expect(resolveDeploymentConfig(external, secrets)).toMatchObject({
      topology: { execution: 'external', sharedFilesystem: false },
      capabilities: { claudeAuth: false, claudeOAuth: false },
    });
  });

  it('rejects an auth-resolved HA topology with a shared credential home', () => {
    expect(() =>
      resolveDeploymentConfig(
        {
          ...haConfig,
          multi_tenancy: { mode: 'required_from_auth', auth_claim: 'tenant_id' },
        },
        secrets
      )
    ).toThrow('auth-resolved execution requires execution.executor_storage.user_home');
  });

  it('admits auth-resolved HA only with a persistent per-user credential home', () => {
    const deployment = resolveDeploymentConfig(
      {
        ...haConfig,
        multi_tenancy: { mode: 'required_from_auth', auth_claim: 'tenant_id' },
        execution: {
          ...haConfig.execution,
          executor_storage: {
            user_home: 'persistent-per-user',
            user_home_locking: 'cross-replica-flock',
            branch_workspace: 'shared',
            base_repository: 'shared',
          },
        },
      },
      secrets
    );
    expect(deployment.mode).toBe('ha');
    if (deployment.mode !== 'ha') throw new Error('Expected HA deployment');
    expect(deployment.capabilities.codexCredentialFiles).toBe(true);
    expect(deployment.capabilities.codexDeviceAuth).toBe(false);
    expect(deployment.capabilities.claudeAuth).toBe(false);
    expect(deployment.capabilities.claudeOAuth).toBe(false);
  });

  it('keeps Claude OAuth gated without containment while admitting safe cleanup', () => {
    const deployment = resolveDeploymentConfig(
      {
        ...haConfig,
        execution: {
          ...haConfig.execution,
          unix_user_mode: 'sandbox',
          executor_storage: {
            user_home: 'persistent-per-user',
            user_home_locking: 'cross-replica-flock',
            branch_workspace: 'shared',
            base_repository: 'shared',
          },
        },
      },
      secrets
    );
    expect(deployment.mode).toBe('ha');
    if (deployment.mode !== 'ha') throw new Error('Expected HA deployment');
    expect(deployment.capabilities.codexDeviceAuth).toBe(true);
    expect(deployment.capabilities.claudeAuth).toBe(true);
    expect(deployment.capabilities.claudeOAuth).toBe(false);
  });

  it('admits Claude HA only with exact-user routing, cross-replica locking, and containment', () => {
    const deployment = resolveDeploymentConfig(
      {
        ...haConfig,
        execution: {
          ...haConfig.execution,
          unix_user_mode: 'sandbox',
          executor_storage: {
            user_home: 'persistent-per-user',
            user_home_locking: 'cross-replica-flock',
            branch_workspace: 'shared',
            base_repository: 'shared',
          },
          sandbox: { enabled: true, home_mode: 'per_user' },
        },
      },
      secrets
    );
    expect(deployment.mode).toBe('ha');
    if (deployment.mode !== 'ha') throw new Error('Expected HA deployment');
    expect(deployment.capabilities.claudeAuth).toBe(true);
    expect(deployment.capabilities.claudeOAuth).toBe(true);
  });

  it('gates Claude HA when an extra writable path can re-expose the physical home store', () => {
    const deployment = resolveDeploymentConfig(
      {
        ...haConfig,
        execution: {
          ...haConfig.execution,
          unix_user_mode: 'sandbox',
          executor_storage: {
            user_home: 'persistent-per-user',
            user_home_locking: 'cross-replica-flock',
            branch_workspace: 'shared',
            base_repository: 'shared',
          },
          sandbox: {
            enabled: true,
            home_mode: 'per_user',
            extra_allow_write: ['/home/agor/.agor'],
          },
        },
      },
      secrets
    );
    expect(deployment.mode).toBe('ha');
    if (deployment.mode !== 'ha') throw new Error('Expected HA deployment');
    expect(deployment.capabilities.claudeAuth).toBe(true);
    expect(deployment.capabilities.claudeOAuth).toBe(false);
  });
  it.each(['sandbox', 'delegated'] as const)(
    'admits HA device auth with a concrete %s exact-user credential route',
    (unixUserMode) => {
      const deployment = resolveDeploymentConfig(
        {
          ...haConfig,
          execution: {
            ...haConfig.execution,
            unix_user_mode: unixUserMode,
            executor_storage: {
              user_home: 'persistent-per-user',
              user_home_locking: 'cross-replica-flock',
              branch_workspace: 'shared',
              base_repository: 'shared',
            },
          },
        },
        secrets
      );
      expect(deployment.mode).toBe('ha');
      if (deployment.mode !== 'ha') throw new Error('Expected HA deployment');
      expect(deployment.capabilities.codexDeviceAuth).toBe(true);
    }
  );

  it('gates HA Codex credential mutation without cross-replica flock', () => {
    const deployment = resolveDeploymentConfig(
      {
        ...haConfig,
        execution: {
          ...haConfig.execution,
          unix_user_mode: 'sandbox',
          executor_storage: {
            user_home: 'persistent-per-user',
            user_home_locking: 'local-only',
            branch_workspace: 'shared',
            base_repository: 'shared',
          },
        },
      },
      secrets
    );
    expect(deployment.mode).toBe('ha');
    if (deployment.mode !== 'ha') throw new Error('Expected HA deployment');
    expect(deployment.capabilities.codexCredentialFiles).toBe(false);
    expect(deployment.capabilities.codexDeviceAuth).toBe(false);
    expect(deployment.capabilities.claudeAuth).toBe(false);
    expect(deployment.capabilities.claudeOAuth).toBe(false);
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
