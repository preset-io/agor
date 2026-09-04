/**
 * Tests for Agor Config Manager
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as yaml from 'js-yaml';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetConfigCacheForTests,
  AtomicConfigPublicationUnsupportedError,
  assertValidEffectiveExecutionConfig,
  assertValidRawConfig,
  ConfigAlreadyExistsError,
  createInitialConfig,
  ensureBranchCloneDepthAllowed,
  ensureBranchStorageModeAllowed,
  expandHomePath,
  getAgorHome,
  getBaseUrl,
  getBranchesDir,
  getBranchPath,
  getConfigPath,
  getConfigValue,
  getDaemonBaseUrl,
  getDaemonUrl,
  getDataHome,
  getDefaultConfig,
  getReposDir,
  getTenantDataRoot,
  initConfig,
  isBranchRbacEnabled,
  loadConfig,
  loadConfigSync,
  PublicBaseUrlNotConfiguredError,
  RETIRED_CONFIG_KEYS,
  requirePublicBaseUrl,
  resolveBranchStorageConfig,
  resolveEffectiveConfig,
  resolveExecutionSecurityMode,
  resolveTeammateFrameworkRepoUrl,
  rewriteConfigForTests,
  saveConfigForTests,
  unixUserModeRequiresExecutionHomeKey,
} from './config-manager';
import type { AgorConfig } from './types';

/**
 * Helper: Create test config data
 */
function createConfigData(overrides?: Partial<AgorConfig>): AgorConfig {
  return {
    daemon: {
      port: 4000,
      host: '0.0.0.0',
    },
    ui: {
      port: 8080,
      host: '127.0.0.1',
    },
    ...overrides,
  };
}

/**
 * Helper: Create minimal config
 */
function createMinimalConfig(): AgorConfig {
  return {
    daemon: { port: 3030 },
  };
}

describe('getAgorHome', () => {
  it('should return ~/.agor path', () => {
    const home = getAgorHome();
    expect(home).toBe(path.join(os.homedir(), '.agor'));
  });
});

describe('getConfigPath', () => {
  it('should return ~/.agor/config.yaml path', () => {
    const configPath = getConfigPath();
    expect(configPath).toBe(path.join(os.homedir(), '.agor', 'config.yaml'));
  });
});

describe('getDefaultConfig', () => {
  it('should return complete default config structure', () => {
    const defaults = getDefaultConfig();

    // Verify structure and key defaults
    expect(defaults.daemon?.port).toBe(3030);
    expect(defaults.daemon?.host).toBe('localhost');
    expect(defaults.ui?.port).toBe(5173);
    expect(defaults.ui?.host).toBe('localhost');
    expect(defaults.identity?.password_policy).toBe('secure');
    expect(defaults.analytics?.enabled).toBe(false);
    expect(defaults.metrics?.statsd).toEqual({
      enabled: false,
      host: '127.0.0.1',
      port: 8125,
      prefix: 'agor.daemon.',
      global_tags: {},
    });
  });
});

describe('resolveEffectiveConfig', () => {
  it('keeps the fail-safe password profile out of environment-variable override space', () => {
    const resolved = resolveEffectiveConfig(
      { identity: { password_policy: 'secure' } },
      { AGOR_PASSWORD_POLICY: 'development' }
    );
    expect(resolved.identity?.password_policy).toBe('secure');
  });

  it('materializes defaults and supported environment overrides without mutating input', () => {
    const input: AgorConfig = { daemon: { host: 'yaml-host', port: 1234 } };
    const resolved = resolveEffectiveConfig(input, {
      PORT: '4321',
      DAEMON_HOST: 'env-host',
      AGOR_RBAC_ENABLED: 'true',
      AGOR_UNIX_USER_MODE: 'delegated',
      INSTANCE_LABEL: 'replica-a',
    });
    expect(resolved.daemon).toMatchObject({
      host: 'env-host',
      port: 4321,
      mcpEnabled: true,
      instanceLabel: 'replica-a',
    });
    expect(resolved.execution).toMatchObject({ branch_rbac: true, unix_user_mode: 'delegated' });
    expect(resolved.multi_tenancy?.mode).toBe('static');
    expect(input).toEqual({ daemon: { host: 'yaml-host', port: 1234 } });
  });

  it('projects AGOR_DATA_HOME into the effective config snapshot', () => {
    const resolved = resolveEffectiveConfig(
      { paths: { data_home: '/from-yaml' } },
      { AGOR_DATA_HOME: '/from-environment' }
    );
    expect(resolved.paths?.data_home).toBe('/from-environment');
  });

  it('projects the replica-local executor response origin without mutating YAML', () => {
    const input: AgorConfig = {
      execution: {
        executor_response: {
          max_response_bytes: 2 * 1024 * 1024,
          timeout_ms: {
            default: 300_000,
            by_command: { 'branch.files.read': 60_000 },
          },
          origin_url: 'https://yaml-daemon.internal',
        },
      },
    };
    const resolved = resolveEffectiveConfig(input, {
      AGOR_EXECUTOR_RESPONSE_ORIGIN_URL: 'http://daemon-2.agor.svc:3030',
    });

    expect(resolved.execution?.executor_response).toEqual({
      max_response_bytes: 2 * 1024 * 1024,
      timeout_ms: {
        default: 300_000,
        by_command: { 'branch.files.read': 60_000 },
      },
      origin_url: 'http://daemon-2.agor.svc:3030',
    });
    expect(input.execution?.executor_response?.origin_url).toBe('https://yaml-daemon.internal');
  });

  it('materializes StatsD YAML and strict environment overrides', () => {
    const input: AgorConfig = {
      metrics: {
        statsd: {
          enabled: false,
          host: 'yaml-agent',
          port: 18125,
          prefix: 'custom.',
          global_tags: { env: 'staging' },
        },
      },
    };
    const resolved = resolveEffectiveConfig(input, {
      AGOR_STATSD_ENABLED: '1',
      AGOR_STATSD_HOST: '127.0.0.2',
      AGOR_STATSD_PORT: '28125',
      AGOR_STATSD_PREFIX: 'company.agor.',
    });
    expect(resolved.metrics?.statsd).toEqual({
      enabled: true,
      host: '127.0.0.2',
      port: 28125,
      prefix: 'company.agor.',
      global_tags: { env: 'staging' },
    });
    expect(input.metrics?.statsd?.enabled).toBe(false);
  });

  it('rejects invalid StatsD environment overrides', () => {
    expect(() => resolveEffectiveConfig({}, { AGOR_STATSD_ENABLED: 'yes' })).toThrow(
      /AGOR_STATSD_ENABLED/
    );
    expect(() => resolveEffectiveConfig({}, { AGOR_STATSD_PORT: '8125udp' })).toThrow(
      /AGOR_STATSD_PORT/
    );
    expect(() => resolveEffectiveConfig({}, { AGOR_STATSD_PORT: '70000' })).toThrow(
      /AGOR_STATSD_PORT/
    );
    expect(() => resolveEffectiveConfig({}, { AGOR_STATSD_PREFIX: 'missing-dot' })).toThrow(
      /metrics\.statsd\.prefix/
    );
  });

  it.each(['opportunistic', 'strict', 'insulated'])(
    'rejects removed AGOR_UNIX_USER_MODE=%s overrides with migration guidance',
    (mode) => {
      expect(() => resolveEffectiveConfig({}, { AGOR_UNIX_USER_MODE: mode })).toThrow(
        new RegExp(`${mode}.*removed in Agor 0\\.25\\.0`, 's')
      );
    }
  );

  it('rejects an unknown AGOR_UNIX_USER_MODE override', () => {
    expect(() => resolveEffectiveConfig({}, { AGOR_UNIX_USER_MODE: 'root' })).toThrow(
      /must be one of: simple, sandbox, delegated/
    );
  });

  it('treats an empty AGOR_UNIX_USER_MODE from Compose as no override', () => {
    expect(resolveEffectiveConfig({}, { AGOR_UNIX_USER_MODE: '' }).execution?.unix_user_mode).toBe(
      resolveEffectiveConfig({}, {}).execution?.unix_user_mode
    );
    expect(
      resolveEffectiveConfig(
        { execution: { unix_user_mode: 'sandbox' } },
        { AGOR_UNIX_USER_MODE: '' }
      ).execution?.unix_user_mode
    ).toBe('sandbox');
  });

  it('unix_user_mode: sandbox implies RBAC + enabled per-user sandbox that fails closed', () => {
    const resolved = resolveEffectiveConfig({ execution: { unix_user_mode: 'sandbox' } }, {});
    expect(resolved.execution?.branch_rbac).toBe(true);
    expect(resolved.execution?.sandbox).toMatchObject({
      enabled: true,
      home_mode: 'per_user',
      fail_if_unavailable: true,
    });
  });

  it('sandbox mode FORCES its security invariants — config/env cannot weaken them', () => {
    const resolved = resolveEffectiveConfig(
      {
        execution: {
          unix_user_mode: 'sandbox',
          // Every one of these attempts to weaken the mode and must be ignored.
          sandbox: { enabled: false, home_mode: 'shared', fail_if_unavailable: false },
        },
      },
      { AGOR_SANDBOX_HOME_MODE: 'shared' }
    );
    expect(resolved.execution?.sandbox).toMatchObject({
      enabled: true,
      home_mode: 'per_user',
      fail_if_unavailable: true,
    });
  });

  it('sandbox mode preserves non-security tunables (include/extras/protect_secrets)', () => {
    const resolved = resolveEffectiveConfig(
      {
        execution: {
          unix_user_mode: 'sandbox',
          sandbox: {
            extra_allow_write: ['/opt/cache'],
            include: { tmp: false },
            preserve_canonical_home_alias: true,
          },
        },
      },
      {}
    );
    expect(resolved.execution?.sandbox?.extra_allow_write).toEqual(['/opt/cache']);
    expect(resolved.execution?.sandbox?.include).toMatchObject({ tmp: false });
    expect(resolved.execution?.sandbox?.preserve_canonical_home_alias).toBe(true);
    expect(resolved.execution?.sandbox).toMatchObject({ enabled: true, home_mode: 'per_user' });
  });

  it('AGOR_SANDBOX_HOME_MODE env still overrides home_mode without the sandbox isolation mode', () => {
    const resolved = resolveEffectiveConfig(
      { execution: { sandbox: { enabled: true } } },
      { AGOR_SANDBOX_HOME_MODE: 'per_user' }
    );
    expect(resolved.execution?.sandbox).toMatchObject({ enabled: true, home_mode: 'per_user' });
    expect(resolved.execution?.branch_rbac).not.toBe(true); // not sandbox mode → no forced RBAC
  });

  it('projects the SDK-home rollout override without implicitly enabling the sandbox', () => {
    const enabled = resolveEffectiveConfig({}, { AGOR_SANDBOX_SDK_HOME_MODE: 'per_branch' });
    expect(enabled.execution?.sandbox).toEqual({ sdk_home_mode: 'per_branch' });
    expect(enabled.execution?.branch_rbac).not.toBe(true);

    const disabled = resolveEffectiveConfig(
      { execution: { sandbox: { sdk_home_mode: 'per_branch' } } },
      { AGOR_SANDBOX_SDK_HOME_MODE: 'inherit' }
    );
    expect(disabled.execution?.sandbox?.sdk_home_mode).toBe('inherit');
  });

  it('rejects an unknown AGOR_SANDBOX_SDK_HOME_MODE override', () => {
    expect(() => resolveEffectiveConfig({}, { AGOR_SANDBOX_SDK_HOME_MODE: 'branch' })).toThrow(
      /must be one of: inherit, per_branch/
    );
  });
});

describe('assertValidEffectiveExecutionConfig', () => {
  it('requires delegated mode to name an external execution substrate', () => {
    expect(() =>
      assertValidEffectiveExecutionConfig({ execution: { unix_user_mode: 'delegated' } })
    ).toThrow(/requires execution\.executor_command_template/);
  });

  it.each(['{unix_user_uid}', '{unix_user_gid}'])(
    'rejects removed delegated template placeholder %s at startup',
    (placeholder) => {
      expect(() =>
        assertValidEffectiveExecutionConfig({
          execution: {
            unix_user_mode: 'delegated',
            executor_command_template: `launcher --legacy ${placeholder} -- {command}`,
          },
        })
      ).toThrow(/removed placeholder/);
    }
  );

  it('requires templated execution to declare request-response support at startup', () => {
    expect(() =>
      assertValidEffectiveExecutionConfig({
        execution: { executor_command_template: 'launcher -- {command}' },
      })
    ).toThrow(/requires request-mode response support/);

    expect(() =>
      assertValidEffectiveExecutionConfig({
        execution: {
          executor_command_template: 'launcher -- {command}',
          executor_response: {
            external_protocol: 'executor-response-v1',
            origin_url: 'http://daemon-0.internal:3030',
          },
        },
      })
    ).not.toThrow();
  });

  it('boots the shared-yaml/per-replica-env executor response split', () => {
    // Regression: one config.yaml declares external_protocol for every
    // replica while the exact origin arrives only via
    // AGOR_EXECUTOR_RESPONSE_ORIGIN_URL (Kubernetes downward-API Pod IP). The
    // raw validation must accept it, and after environment projection the
    // effective config must pass with the env-supplied origin.
    const rawYamlForm: AgorConfig = {
      execution: {
        executor_command_template: 'launcher -- {command}',
        executor_response: { external_protocol: 'executor-response-v1' },
      },
    };
    expect(() => assertValidRawConfig(rawYamlForm)).not.toThrow();

    const resolved = resolveEffectiveConfig(rawYamlForm, {
      AGOR_EXECUTOR_RESPONSE_ORIGIN_URL: 'http://10.35.69.131:3030',
    });
    expect(resolved.execution?.executor_response?.origin_url).toBe('http://10.35.69.131:3030');
    expect(() => assertValidEffectiveExecutionConfig(resolved)).not.toThrow();
  });

  it('still requires an origin for the declared protocol on the effective config', () => {
    // Without an origin from YAML or environment, the declared protocol is
    // unusable; the effective-config gate keeps the raw parser's former
    // guarantee, one projection step later.
    expect(() =>
      assertValidEffectiveExecutionConfig({
        execution: {
          executor_response: { external_protocol: 'executor-response-v1' },
        },
      })
    ).toThrow(/external_protocol requires an exact origin_url/);
  });

  it('rejects sandboxing combined with an external executor template', () => {
    expect(() =>
      assertValidEffectiveExecutionConfig({
        execution: {
          unix_user_mode: 'delegated',
          executor_command_template: 'docker run {{command}}',
          sandbox: { enabled: true },
        },
      })
    ).toThrow(/executor_command_template/);
  });

  it('allows supported standalone and named sandbox configurations', () => {
    expect(() =>
      assertValidEffectiveExecutionConfig(
        resolveEffectiveConfig({ execution: { unix_user_mode: 'sandbox' } }, {})
      )
    ).not.toThrow();
    expect(() =>
      assertValidEffectiveExecutionConfig({
        execution: { unix_user_mode: 'simple', sandbox: { enabled: true } },
      })
    ).not.toThrow();
  });
});

describe('resolveTeammateFrameworkRepoUrl', () => {
  it('uses the operator-owned teammate setting', () => {
    expect(
      resolveTeammateFrameworkRepoUrl({
        teammates: { framework_repo_url: 'https://example.test/canonical.git' },
      })
    ).toBe('https://example.test/canonical.git');
  });

  it('keeps the legacy onboarding key as a compatibility fallback', () => {
    expect(
      resolveTeammateFrameworkRepoUrl({
        onboarding: { frameworkRepoUrl: 'https://example.test/legacy.git' },
      } as unknown as AgorConfig)
    ).toBe('https://example.test/legacy.git');
  });

  it('prefers the canonical setting over the legacy fallback', () => {
    expect(
      resolveTeammateFrameworkRepoUrl({
        teammates: { framework_repo_url: 'https://example.test/canonical.git' },
        onboarding: { frameworkRepoUrl: 'https://example.test/legacy.git' },
      } as unknown as AgorConfig)
    ).toBe('https://example.test/canonical.git');
  });
});

describe('expandHomePath', () => {
  it('should return the original path when no tilde prefix is present', () => {
    expect(expandHomePath('/tmp/example')).toBe('/tmp/example');
  });

  it('should expand a tilde-prefixed path using the user home directory', () => {
    const expected = path.join(os.homedir(), 'workspace');
    expect(expandHomePath('~/workspace')).toBe(expected);
  });
});

describe('loadConfig', () => {
  let tempDir: string;
  let _originalHome: string;

  beforeEach(async () => {
    // Create temp directory for testing
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agor-test-'));

    // Mock os.homedir to use temp directory
    _originalHome = os.homedir();
    vi.spyOn(os, 'homedir').mockReturnValue(tempDir);
  });

  afterEach(async () => {
    // Cleanup
    await fs.rm(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('should load existing config file', async () => {
    const configData = createConfigData();
    const agorDir = path.join(tempDir, '.agor');
    const configPath = path.join(agorDir, 'config.yaml');

    await fs.mkdir(agorDir, { recursive: true });
    await fs.writeFile(configPath, yaml.dump(configData), 'utf-8');

    const loaded = await loadConfig();
    expect(loaded).toMatchObject(configData);
  });

  it('loads the documented canonical-home sandbox compatibility setting', async () => {
    const agorDir = path.join(tempDir, '.agor');
    await fs.mkdir(agorDir, { recursive: true });
    await fs.writeFile(
      path.join(agorDir, 'config.yaml'),
      'execution:\n  unix_user_mode: sandbox\n  sandbox:\n    preserve_canonical_home_alias: true\n',
      'utf-8'
    );

    await expect(loadConfig()).resolves.toMatchObject({
      execution: {
        unix_user_mode: 'sandbox',
        sandbox: { preserve_canonical_home_alias: true },
      },
    });
  });

  it('rejects unknown sandbox keys and a non-boolean canonical-home option', async () => {
    const agorDir = path.join(tempDir, '.agor');
    const configPath = path.join(agorDir, 'config.yaml');
    await fs.mkdir(agorDir, { recursive: true });
    await fs.writeFile(
      configPath,
      'execution:\n  sandbox:\n    preserve_canonical_home_alias: true\n    surprise: true\n',
      'utf-8'
    );

    await expect(loadConfig()).rejects.toThrow(/execution\.sandbox\.surprise/);

    await fs.writeFile(
      configPath,
      'execution:\n  sandbox:\n    preserve_canonical_home_alias: "true"\n',
      'utf-8'
    );
    __resetConfigCacheForTests();
    await expect(loadConfig()).rejects.toThrow(/preserve_canonical_home_alias must be a boolean/);
  });

  it('accepts branch_storage.borrow_base_objects and rejects a non-boolean value', async () => {
    // The escape hatch for deployments whose executors cannot see the
    // daemon's repos/ mount; must survive the strict unknown-key sweep.
    const agorDir = path.join(tempDir, '.agor');
    const configPath = path.join(agorDir, 'config.yaml');
    await fs.mkdir(agorDir, { recursive: true });
    await fs.writeFile(
      configPath,
      'execution:\n  branch_storage:\n    borrow_base_objects: false\n',
      'utf-8'
    );

    await expect(loadConfig()).resolves.toMatchObject({
      execution: { branch_storage: { borrow_base_objects: false } },
    });

    await fs.writeFile(
      configPath,
      'execution:\n  branch_storage:\n    borrow_base_objects: "false"\n',
      'utf-8'
    );
    __resetConfigCacheForTests();
    await expect(loadConfig()).rejects.toThrow(
      /execution\.branch_storage\.borrow_base_objects must be a boolean/
    );
  });

  describe('AGOR_UNKNOWN_CONFIG_KEYS forward-compatibility policy', () => {
    const writeConfigWithFutureKey = async () => {
      const agorDir = path.join(tempDir, '.agor');
      await fs.mkdir(agorDir, { recursive: true });
      // A key an older daemon would not recognize (as if written by a newer one).
      await fs.writeFile(
        path.join(agorDir, 'config.yaml'),
        'execution:\n  a_future_additive_key: true\n',
        'utf-8'
      );
    };

    afterEach(() => {
      delete process.env.AGOR_UNKNOWN_CONFIG_KEYS;
    });

    it('rejects unknown keys by default (fails closed, catches typos)', async () => {
      await writeConfigWithFutureKey();
      __resetConfigCacheForTests();
      await expect(loadConfig()).rejects.toThrow(/execution\.a_future_additive_key/);
    });

    it('tolerates unknown keys and warns when set to warn', async () => {
      process.env.AGOR_UNKNOWN_CONFIG_KEYS = 'warn';
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      await writeConfigWithFutureKey();
      __resetConfigCacheForTests();

      await expect(loadConfig()).resolves.toBeTruthy();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('execution.a_future_additive_key'));
    });

    it('rejects an invalid policy value', async () => {
      process.env.AGOR_UNKNOWN_CONFIG_KEYS = 'lenient';
      await writeConfigWithFutureKey();
      __resetConfigCacheForTests();
      await expect(loadConfig()).rejects.toThrow(/AGOR_UNKNOWN_CONFIG_KEYS must be/);
    });
  });

  it('boots with a full mcp_catalog block from before the catalog moved into the repository', async () => {
    // The catalog is a file in this repository and has nothing to configure,
    // but an unrecognized top-level key throws — so removing the section
    // outright would stop the daemon of every operator who has one in their
    // config. Every key it ever accepted has to keep loading, and be ignored.
    //
    // AGENTS.md no longer documents the block, so this restates the keys rather
    // than scraping them out of the docs the way the pre-retirement test did.
    const agorDir = path.join(tempDir, '.agor');
    await fs.mkdir(agorDir, { recursive: true });
    await fs.writeFile(
      path.join(agorDir, 'config.yaml'),
      yaml.dump({
        mcp_catalog: {
          registry_sync_enabled: true,
          sync_interval_hours: 12,
          probe_budget: 40,
          registry_url: 'https://registry.internal',
        },
      }),
      'utf-8'
    );

    const loaded = await loadConfig();
    // Loaded rather than rejected, and carrying no setting anything reads.
    expect(loaded).toBeDefined();
    expect(RETIRED_CONFIG_KEYS.mcp_catalog).toEqual([
      'registry_sync_enabled',
      'sync_interval_hours',
      'probe_budget',
      'registry_url',
    ]);
  });

  it('rejects an unknown mcp_catalog subkey rather than silently accepting it', async () => {
    // Retired is not the same as unvalidated: a key that never existed is a
    // typo, and accepting it would teach an operator that a setting they
    // invented is doing something.
    const agorDir = path.join(tempDir, '.agor');
    await fs.mkdir(agorDir, { recursive: true });
    await fs.writeFile(
      path.join(agorDir, 'config.yaml'),
      yaml.dump({ mcp_catalog: { registry_sync_enabld: true } }),
      'utf-8'
    );

    await expect(loadConfig()).rejects.toThrow(/mcp_catalog\.registry_sync_enabld/);
  });

  it('should return default config when file does not exist', async () => {
    const loaded = await loadConfig();
    const defaults = getDefaultConfig();
    expect(loaded).toEqual(defaults);
  });

  // Manufacturing the mask's EACCES needs mode bits, which don't constrain
  // root and aren't honored off POSIX — same reason as the unreadable-file
  // test below.
  it.skipIf(process.getuid === undefined || process.getuid() === 0)(
    'should explain the sandbox rather than fabricate a config when masked',
    async () => {
      // The executor sandbox masks the daemon's config.yaml with a `--ro-bind
      // /dev/null` mount, so reads from inside fail with EACCES rather than
      // ENOENT. Falling back to defaults here would be worse than failing: the
      // defaults carry no `paths` key and disable filesystem isolation, so a
      // fabricated config resolves tenant data roots to the wrong directory.
      // Mounting needs privileges tests don't have; an unreadable file
      // produces the same EACCES the mask does.
      const agorDir = path.join(tempDir, '.agor');
      const configPath = path.join(agorDir, 'config.yaml');

      await fs.mkdir(agorDir, { recursive: true });
      await fs.writeFile(configPath, yaml.dump(createConfigData()), 'utf-8');
      await fs.chmod(configPath, 0o000);
      vi.stubEnv('AGOR_OUTER_SANDBOX', '1');

      try {
        await expect(loadConfig()).rejects.toThrow(
          /masked by Agor's executor sandbox.*payload\.resolvedConfig and DAEMON_URL/s
        );

        __resetConfigCacheForTests();
        expect(() => loadConfigSync()).toThrow(/masked by Agor's executor sandbox/s);
      } finally {
        // restoreAllMocks() does not undo stubEnv, and the marker leaking into
        // later tests would silently rewrite their expected errors.
        vi.unstubAllEnvs();
        await fs.chmod(configPath, 0o600);
      }
    }
  );

  // The masked-config diagnostic is a better message, never a different
  // outcome: outside the sandbox the same failures stay loud and unchanged.
  it('should fail loudly when the config path is a directory', async () => {
    const agorDir = path.join(tempDir, '.agor');
    const configPath = path.join(agorDir, 'config.yaml');

    await fs.mkdir(agorDir, { recursive: true });
    await fs.mkdir(configPath);

    await expect(loadConfig()).rejects.toThrow(/Failed to load config.*EISDIR/s);

    __resetConfigCacheForTests();
    expect(() => loadConfigSync()).toThrow(/Failed to load config.*EISDIR/s);
  });

  // Permission bits don't constrain root, and non-POSIX hosts don't honor
  // mode 000 at all, so this can only assert anything as an unprivileged
  // POSIX user.
  it.skipIf(process.getuid === undefined || process.getuid() === 0)(
    'should fail loudly when a regular config file is unreadable',
    async () => {
      const agorDir = path.join(tempDir, '.agor');
      const configPath = path.join(agorDir, 'config.yaml');

      await fs.mkdir(agorDir, { recursive: true });
      await fs.writeFile(configPath, yaml.dump(createConfigData()), 'utf-8');
      await fs.chmod(configPath, 0o000);

      try {
        await expect(loadConfig()).rejects.toThrow(/Failed to load config.*EACCES/s);

        __resetConfigCacheForTests();
        expect(() => loadConfigSync()).toThrow(/Failed to load config.*EACCES/s);
      } finally {
        // Restore so the afterEach cleanup can remove it.
        await fs.chmod(configPath, 0o600);
      }
    }
  );

  it('should return empty config for empty YAML file', async () => {
    const agorDir = path.join(tempDir, '.agor');
    const configPath = path.join(agorDir, 'config.yaml');

    await fs.mkdir(agorDir, { recursive: true });
    await fs.writeFile(configPath, '', 'utf-8');

    const loaded = await loadConfig();
    expect(loaded).toEqual({});
  });

  it('should throw error for invalid YAML', async () => {
    const agorDir = path.join(tempDir, '.agor');
    const configPath = path.join(agorDir, 'config.yaml');

    await fs.mkdir(agorDir, { recursive: true });
    await fs.writeFile(configPath, 'invalid: yaml: [content', 'utf-8');

    await expect(loadConfig()).rejects.toThrow('Failed to load config');
  });

  it('accepts managed environment webhook-only execution mode', async () => {
    const agorDir = path.join(tempDir, '.agor');
    const configPath = path.join(agorDir, 'config.yaml');

    await fs.mkdir(agorDir, { recursive: true });
    await fs.writeFile(
      configPath,
      yaml.dump({ execution: { managed_envs_execution_mode: 'webhook-only' } }),
      'utf-8'
    );

    await expect(loadConfig()).resolves.toMatchObject({
      execution: { managed_envs_execution_mode: 'webhook-only' },
    });
  });

  it('rejects invalid managed environment execution modes', async () => {
    const agorDir = path.join(tempDir, '.agor');
    const configPath = path.join(agorDir, 'config.yaml');

    await fs.mkdir(agorDir, { recursive: true });
    await fs.writeFile(
      configPath,
      yaml.dump({ execution: { managed_envs_execution_mode: 'docker' } }),
      'utf-8'
    );

    await expect(loadConfig()).rejects.toThrow(
      /execution\.managed_envs_execution_mode must be one of: hybrid, webhook-only/
    );
  });

  it('accepts a bounded plain-text environment notice with a safe documentation link', async () => {
    const agorDir = path.join(tempDir, '.agor');
    const configPath = path.join(agorDir, 'config.yaml');

    await fs.mkdir(agorDir, { recursive: true });
    await fs.writeFile(
      configPath,
      yaml.dump({
        ui: {
          environment_notice: {
            severity: 'warning',
            title: 'Remote environments',
            message: 'Agor can call your environment provider, but does not host the runtime.',
            link: {
              label: 'Environment documentation',
              url: 'https://agor.live/guide/environment-configuration',
            },
          },
        },
      }),
      'utf-8'
    );

    await expect(loadConfig()).resolves.toMatchObject({
      ui: {
        environment_notice: {
          severity: 'warning',
          title: 'Remote environments',
          link: { url: 'https://agor.live/guide/environment-configuration' },
        },
      },
    });
  });

  it.each([
    [{ title: '', message: 'Body' }, /environment_notice\.title must not be empty/],
    [{ title: 'Title', message: '' }, /environment_notice\.message must not be empty/],
    [
      { severity: 'critical', title: 'Title', message: 'Body' },
      /severity must be one of: info, success, warning, error/,
    ],
    [
      {
        title: 'Title',
        message: 'Body',
        link: { label: 'Insecure', url: 'http://docs.example.com/environment' },
      },
      /link\.url must be an HTTPS URL or a same-origin path/,
    ],
    [
      {
        title: 'Title',
        message: 'Body',
        link: { label: 'Unsafe', url: 'javascript:alert(1)' },
      },
      /link\.url must be an HTTPS URL or a same-origin path/,
    ],
    [
      {
        title: 'Title',
        message: 'Body',
        link: { label: 'Credentials', url: 'https://user:secret@example.com/docs' },
      },
      /link\.url must not include URL credentials/,
    ],
    [
      {
        title: 'Title',
        message: 'Body',
        link: { label: 'Protocol relative', url: '//evil.example/docs' },
      },
      /link\.url must be an HTTPS URL or a same-origin path/,
    ],
  ])('rejects invalid environment notice settings %#', async (environmentNotice, expected) => {
    const agorDir = path.join(tempDir, '.agor');
    const configPath = path.join(agorDir, 'config.yaml');

    await fs.mkdir(agorDir, { recursive: true });
    await fs.writeFile(
      configPath,
      yaml.dump({ ui: { environment_notice: environmentNotice } }),
      'utf-8'
    );

    await expect(loadConfig()).rejects.toThrow(expected);
  });

  it('rejects oversized environment notice content', async () => {
    const agorDir = path.join(tempDir, '.agor');
    const configPath = path.join(agorDir, 'config.yaml');

    await fs.mkdir(agorDir, { recursive: true });
    await fs.writeFile(
      configPath,
      yaml.dump({
        ui: { environment_notice: { title: 'Title', message: 'x'.repeat(2_001) } },
      }),
      'utf-8'
    );

    await expect(loadConfig()).rejects.toThrow(/environment_notice\.message must be at most 2000/);
  });

  it('rejects arbitrary environment notice rich-content fields', async () => {
    const agorDir = path.join(tempDir, '.agor');
    const configPath = path.join(agorDir, 'config.yaml');

    await fs.mkdir(agorDir, { recursive: true });
    await fs.writeFile(
      configPath,
      yaml.dump({
        ui: {
          environment_notice: {
            title: 'Title',
            message: 'Body',
            html: '<script>alert(1)</script>',
          },
        },
      }),
      'utf-8'
    );

    await expect(loadConfig()).rejects.toThrow(/unrecognized key: ui\.environment_notice\.html/);
  });

  it.each(['resources', 'services', 'credentials', 'opencode', 'codex', 'knowledge'])(
    'rejects the removed %s config surface',
    async (key) => {
      const agorDir = path.join(tempDir, '.agor');
      const configPath = path.join(agorDir, 'config.yaml');
      await fs.mkdir(agorDir, { recursive: true });
      await fs.writeFile(configPath, yaml.dump({ [key]: {} }), 'utf-8');

      await expect(loadConfig()).rejects.toThrow(new RegExp(`'${key}' has been removed`));
    }
  );

  it('rejects the removed execution.cursor_sdk_enabled flag', async () => {
    const agorDir = path.join(tempDir, '.agor');
    const configPath = path.join(agorDir, 'config.yaml');
    await fs.mkdir(agorDir, { recursive: true });
    await fs.writeFile(configPath, yaml.dump({ execution: { cursor_sdk_enabled: true } }), 'utf-8');
    await expect(loadConfig()).rejects.toThrow(/execution\.cursor_sdk_enabled.*removed/);
  });

  it('rejects unrecognized top-level keys', async () => {
    const agorDir = path.join(tempDir, '.agor');
    const configPath = path.join(agorDir, 'config.yaml');
    await fs.mkdir(agorDir, { recursive: true });
    await fs.writeFile(configPath, yaml.dump({ speculative_feature: true }), 'utf-8');
    await expect(loadConfig()).rejects.toThrow(/unrecognized top-level key: speculative_feature/);
  });

  it('loads the StatsD surface and rejects unsafe or high-cardinality settings', async () => {
    const agorDir = path.join(tempDir, '.agor');
    const configPath = path.join(agorDir, 'config.yaml');
    await fs.mkdir(agorDir, { recursive: true });
    await fs.writeFile(
      configPath,
      yaml.dump({
        metrics: {
          statsd: {
            enabled: true,
            host: '127.0.0.1',
            port: 8125,
            prefix: 'agor.daemon.',
            global_tags: { env: 'test', region: 'local' },
          },
        },
      }),
      'utf-8'
    );
    await expect(loadConfig()).resolves.toMatchObject({
      metrics: { statsd: { enabled: true, global_tags: { env: 'test', region: 'local' } } },
    });

    for (const [field, value, message] of [
      ['port', 0, 'port'],
      ['prefix', 'agor', 'prefix'],
      ['host', 'http://agent:8125', 'host'],
    ] as const) {
      __resetConfigCacheForTests();
      await fs.writeFile(
        configPath,
        yaml.dump({ metrics: { statsd: { [field]: value } } }),
        'utf-8'
      );
      await expect(loadConfig()).rejects.toThrow(new RegExp(`metrics\\.statsd\\.${message}`));
    }

    for (const reservedKey of ['session_id', 'deployment_id']) {
      __resetConfigCacheForTests();
      await fs.writeFile(
        configPath,
        yaml.dump({ metrics: { statsd: { global_tags: { [reservedKey]: 'anything' } } } }),
        'utf-8'
      );
      await expect(loadConfig()).rejects.toThrow(/low-cardinality policy/);
    }

    __resetConfigCacheForTests();
    await fs.writeFile(
      configPath,
      yaml.dump({
        metrics: {
          statsd: { global_tags: { env: '0198d20e-7182-7000-8000-000000000000' } },
        },
      }),
      'utf-8'
    );
    await expect(loadConfig()).rejects.toThrow(/low-cardinality string/);

    __resetConfigCacheForTests();
    await fs.writeFile(configPath, yaml.dump({ metrics: { statsd: { surprise: true } } }), 'utf-8');
    await expect(loadConfig()).rejects.toThrow(/metrics\.statsd\.surprise/);

    __resetConfigCacheForTests();
    await fs.writeFile(configPath, yaml.dump({ metrics: true }), 'utf-8');
    await expect(loadConfig()).rejects.toThrow(/metrics must be an object/);
  });

  it('defaults APM service tracing to off and validates the depth knob', async () => {
    const agorDir = path.join(tempDir, '.agor');
    const configPath = path.join(agorDir, 'config.yaml');
    await fs.mkdir(agorDir, { recursive: true });

    // Default: off, present so callers can read it without optional-chaining.
    expect(getDefaultConfig().metrics?.apm).toEqual({ trace_services: 'off' });

    // Env override wins over file config, for flipping depth without a redeploy.
    expect(
      resolveEffectiveConfig(
        { metrics: { apm: { trace_services: 'off' } } },
        { AGOR_APM_TRACE_SERVICES: 'full' }
      ).metrics?.apm?.trace_services
    ).toBe('full');
    expect(() => resolveEffectiveConfig({}, { AGOR_APM_TRACE_SERVICES: 'loud' })).toThrow(
      /AGOR_APM_TRACE_SERVICES must be one of/
    );

    for (const depth of ['off', 'entrypoint', 'full'] as const) {
      __resetConfigCacheForTests();
      await fs.writeFile(
        configPath,
        yaml.dump({ metrics: { apm: { trace_services: depth } } }),
        'utf-8'
      );
      await expect(loadConfig()).resolves.toMatchObject({
        metrics: { apm: { trace_services: depth } },
      });
    }

    __resetConfigCacheForTests();
    await fs.writeFile(
      configPath,
      yaml.dump({ metrics: { apm: { trace_services: 'verbose' } } }),
      'utf-8'
    );
    await expect(loadConfig()).rejects.toThrow(/metrics\.apm\.trace_services must be one of/);

    __resetConfigCacheForTests();
    await fs.writeFile(configPath, yaml.dump({ metrics: { apm: { surprise: true } } }), 'utf-8');
    await expect(loadConfig()).rejects.toThrow(/metrics\.apm\.surprise/);

    __resetConfigCacheForTests();
    await fs.writeFile(configPath, yaml.dump({ metrics: { apm: [] } }), 'utf-8');
    await expect(loadConfig()).rejects.toThrow(/metrics\.apm must be an object/);
  });

  it('accepts a deployment-owned agentic tool package list', async () => {
    const agorDir = path.join(tempDir, '.agor');
    const configPath = path.join(agorDir, 'config.yaml');
    await fs.mkdir(agorDir, { recursive: true });
    await fs.writeFile(
      configPath,
      yaml.dump({ agentic_tools: { installed: ['claude-code', 'codex'] } }),
      'utf-8'
    );
    await expect(loadConfig()).resolves.toMatchObject({
      agentic_tools: { installed: ['claude-code', 'codex'] },
    });
  });

  it('accepts only a boolean Claude subscription OAuth release flag', async () => {
    const agorDir = path.join(tempDir, '.agor');
    const configPath = path.join(agorDir, 'config.yaml');
    await fs.mkdir(agorDir, { recursive: true });
    await fs.writeFile(
      configPath,
      yaml.dump({ agentic_tools: { claude_subscription_oauth: true } }),
      'utf-8'
    );
    await expect(loadConfig()).resolves.toMatchObject({
      agentic_tools: { claude_subscription_oauth: true },
    });

    __resetConfigCacheForTests();
    await fs.writeFile(
      configPath,
      yaml.dump({ agentic_tools: { claude_subscription_oauth: 'yes' } }),
      'utf-8'
    );
    await expect(loadConfig()).rejects.toThrow(/claude_subscription_oauth must be a boolean/);
  });

  it('rejects unsupported or duplicate configured agentic tools', async () => {
    const agorDir = path.join(tempDir, '.agor');
    const configPath = path.join(agorDir, 'config.yaml');
    await fs.mkdir(agorDir, { recursive: true });
    await fs.writeFile(
      configPath,
      yaml.dump({ agentic_tools: { installed: ['codex', 'codex'] } }),
      'utf-8'
    );
    await expect(loadConfig()).rejects.toThrow(/duplicate tool.*codex/);

    __resetConfigCacheForTests();
    await fs.writeFile(
      configPath,
      yaml.dump({ agentic_tools: { installed: ['future-tool'] } }),
      'utf-8'
    );
    await expect(loadConfig()).rejects.toThrow(/unsupported tool.*future-tool/);
  });

  it('rejects the removed proxies config surface as an unknown top-level key', async () => {
    const agorDir = path.join(tempDir, '.agor');
    const configPath = path.join(agorDir, 'config.yaml');
    await fs.mkdir(agorDir, { recursive: true });
    await fs.writeFile(
      configPath,
      yaml.dump({ proxies: { shortcut: { upstream: 'https://api.app.shortcut.com' } } }),
      'utf-8'
    );
    await expect(loadConfig()).rejects.toThrow(/unrecognized top-level key: proxies/);
  });

  it('continues to accept daemon.trust_proxy_hops for deployment reverse proxies', async () => {
    const agorDir = path.join(tempDir, '.agor');
    const configPath = path.join(agorDir, 'config.yaml');
    await fs.mkdir(agorDir, { recursive: true });
    await fs.writeFile(configPath, yaml.dump({ daemon: { trust_proxy_hops: 2 } }), 'utf-8');
    await expect(loadConfig()).resolves.toMatchObject({ daemon: { trust_proxy_hops: 2 } });
  });

  it('reports every unrecognized nested key with its full path', async () => {
    const agorDir = path.join(tempDir, '.agor');
    const configPath = path.join(agorDir, 'config.yaml');
    await fs.mkdir(agorDir, { recursive: true });
    await fs.writeFile(
      configPath,
      yaml.dump({
        daemon: { surprise: true },
        execution: {
          branch_storage: { mystery: 1 },
          executor_response: { timeout_ms: { unexpected: 1 } },
        },
      }),
      'utf-8'
    );
    await expect(loadConfig()).rejects.toThrow(
      /daemon\.surprise.*execution\.executor_response\.timeout_ms\.unexpected.*execution\.branch_storage\.mystery/
    );
  });

  it('loads known deprecated nested keys so startup can print migration guidance', async () => {
    const agorDir = path.join(tempDir, '.agor');
    const configPath = path.join(agorDir, 'config.yaml');
    await fs.mkdir(agorDir, { recursive: true });
    await fs.writeFile(
      configPath,
      yaml.dump({
        daemon: { allowAnonymous: false, requireAuth: true },
        defaults: { board: 'main', agent: 'claude-code' },
        display: { shortIdLength: 12, tableStyle: 'ascii', colorOutput: false },
        execution: { managed_envs_minimum_role: 'admin' },
        branches: { others_can_default: 'view', others_fs_access_default: 'none' },
        onboarding: { teammatePending: true, frameworkRepoUrl: 'https://example.test/repo.git' },
      }),
      'utf-8'
    );
    await expect(loadConfig()).resolves.toMatchObject({
      daemon: { allowAnonymous: false, requireAuth: true },
      defaults: { board: 'main', agent: 'claude-code' },
      display: { shortIdLength: 12, tableStyle: 'ascii', colorOutput: false },
      execution: { managed_envs_minimum_role: 'admin' },
      branches: { others_can_default: 'view', others_fs_access_default: 'none' },
      onboarding: { teammatePending: true, frameworkRepoUrl: 'https://example.test/repo.git' },
    });
  });

  it('should handle partial config with missing sections', async () => {
    const partialConfig: AgorConfig = {
      daemon: { port: 4040 },
      // Missing other sections
    };

    const agorDir = path.join(tempDir, '.agor');
    const configPath = path.join(agorDir, 'config.yaml');

    await fs.mkdir(agorDir, { recursive: true });
    await fs.writeFile(configPath, yaml.dump(partialConfig), 'utf-8');

    const loaded = await loadConfig();
    expect(loaded.daemon?.port).toBe(4040);
  });

  it('does not configure an external launch login redirect by default', async () => {
    const loaded = await loadConfig();
    expect(loaded.external_launch?.login_redirect_url).toBeUndefined();
  });

  it('loads the explicit external identity authority contract', async () => {
    const agorDir = path.join(tempDir, '.agor');
    const configPath = path.join(agorDir, 'config.yaml');
    await fs.mkdir(agorDir, { recursive: true });
    await fs.writeFile(
      configPath,
      yaml.dump({
        identity: {
          user_lifecycle: 'external',
          role_authority: 'claims',
          local_auth: 'disabled',
          external: { provider: 'external_launch', provisioning: 'jit' },
        },
      }),
      'utf-8'
    );

    await expect(loadConfig()).resolves.toMatchObject({
      identity: {
        user_lifecycle: 'external',
        role_authority: 'claims',
        local_auth: 'disabled',
        external: { provider: 'external_launch', provisioning: 'jit' },
      },
    });
  });

  it('accepts only the named secure password profile and fails closed on weak profiles', async () => {
    const agorDir = path.join(tempDir, '.agor');
    const configPath = path.join(agorDir, 'config.yaml');
    await fs.mkdir(agorDir, { recursive: true });
    await fs.writeFile(configPath, yaml.dump({ identity: { password_policy: 'secure' } }), 'utf-8');
    await expect(loadConfig()).resolves.toMatchObject({
      identity: { password_policy: 'secure' },
    });

    __resetConfigCacheForTests();
    await fs.writeFile(
      configPath,
      yaml.dump({ identity: { password_policy: 'development' } }),
      'utf-8'
    );
    await expect(loadConfig()).rejects.toThrow(/identity\.password_policy must be 'secure'/);
  });

  it('rejects unknown identity keys and unsupported authority values', async () => {
    const agorDir = path.join(tempDir, '.agor');
    const configPath = path.join(agorDir, 'config.yaml');
    await fs.mkdir(agorDir, { recursive: true });
    await fs.writeFile(
      configPath,
      yaml.dump({ identity: { user_lifecycle: 'remote', surprise: true } }),
      'utf-8'
    );

    await expect(loadConfig()).rejects.toThrow(/identity\.user_lifecycle|identity\.surprise/);
  });

  it('rejects scalar identity and external launch sections', async () => {
    const agorDir = path.join(tempDir, '.agor');
    const configPath = path.join(agorDir, 'config.yaml');
    await fs.mkdir(agorDir, { recursive: true });

    await fs.writeFile(configPath, 'identity: external\n', 'utf-8');
    await expect(loadConfig()).rejects.toThrow(/identity must be an object/);

    await fs.writeFile(configPath, 'external_launch: enabled\n', 'utf-8');
    await expect(loadConfig()).rejects.toThrow(/external_launch must be an object/);

    __resetConfigCacheForTests();
    await fs.writeFile(configPath, 'identity: 2026-08-20\n', 'utf-8');
    await expect(loadConfig()).rejects.toThrow(/identity must be an object/);

    __resetConfigCacheForTests();
    await fs.writeFile(configPath, 'external_launch: 2026-08-20\n', 'utf-8');
    await expect(loadConfig()).rejects.toThrow(/external_launch must be an object/);
  });

  it('accepts an HTTP(S) external launch login redirect URL', async () => {
    const agorDir = path.join(tempDir, '.agor');
    const configPath = path.join(agorDir, 'config.yaml');

    await fs.mkdir(agorDir, { recursive: true });
    await fs.writeFile(
      configPath,
      yaml.dump({
        external_launch: {
          enabled: true,
          login_redirect_url: ' https://workspace.example.com/open ',
        },
      }),
      'utf-8'
    );

    const loaded = await loadConfig();
    // Validation is non-mutating; startup's retained provider owns normalization.
    expect(loaded.external_launch?.login_redirect_url).toBe(' https://workspace.example.com/open ');
  });

  it('rejects a non-HTTP(S) external launch login redirect URL', async () => {
    const agorDir = path.join(tempDir, '.agor');
    const configPath = path.join(agorDir, 'config.yaml');

    await fs.mkdir(agorDir, { recursive: true });
    await fs.writeFile(
      configPath,
      yaml.dump({
        external_launch: {
          enabled: true,
          login_redirect_url: 'javascript:alert(1)',
        },
      }),
      'utf-8'
    );

    await expect(loadConfig()).rejects.toThrow(/external_launch\.login_redirect_url.*http/i);
  });

  it('rejects external_launch.return_host_param equal to the reserved return_to', async () => {
    const agorDir = path.join(tempDir, '.agor');
    const configPath = path.join(agorDir, 'config.yaml');

    await fs.mkdir(agorDir, { recursive: true });
    await fs.writeFile(
      configPath,
      yaml.dump({
        external_launch: { enabled: true, return_host_param: 'return_to' },
      }),
      'utf-8'
    );

    await expect(loadConfig()).rejects.toThrow(/return_host_param.*return_to/i);
  });

  it('accepts a custom external_launch.return_host_param', async () => {
    const agorDir = path.join(tempDir, '.agor');
    const configPath = path.join(agorDir, 'config.yaml');

    await fs.mkdir(agorDir, { recursive: true });
    await fs.writeFile(
      configPath,
      yaml.dump({
        external_launch: { enabled: true, return_host_param: 'workspace_host' },
      }),
      'utf-8'
    );

    const loaded = await loadConfig();
    expect(loaded.external_launch?.return_host_param).toBe('workspace_host');
  });

  it('allows an empty external_launch.return_host_param (falls back to the default)', async () => {
    const agorDir = path.join(tempDir, '.agor');
    const configPath = path.join(agorDir, 'config.yaml');

    await fs.mkdir(agorDir, { recursive: true });
    await fs.writeFile(
      configPath,
      yaml.dump({
        external_launch: { enabled: true, return_host_param: '' },
      }),
      'utf-8'
    );

    const loaded = await loadConfig();
    expect(loaded.external_launch?.return_host_param).toBe('');
  });

  it('rejects an external_launch.return_host_param with invalid characters', async () => {
    const agorDir = path.join(tempDir, '.agor');
    const configPath = path.join(agorDir, 'config.yaml');

    await fs.mkdir(agorDir, { recursive: true });
    await fs.writeFile(
      configPath,
      yaml.dump({
        external_launch: { enabled: true, return_host_param: 'return host&x' },
      }),
      'utf-8'
    );

    await expect(loadConfig()).rejects.toThrow(/return_host_param.*letters/i);
  });
});

describe('loadConfig cache', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agor-cache-'));
    vi.spyOn(os, 'homedir').mockReturnValue(tempDir);
    __resetConfigCacheForTests();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
    __resetConfigCacheForTests();
  });

  async function writeConfigFile(data: AgorConfig | string): Promise<string> {
    const agorDir = path.join(tempDir, '.agor');
    const configPath = path.join(agorDir, 'config.yaml');
    await fs.mkdir(agorDir, { recursive: true });
    const body = typeof data === 'string' ? data : yaml.dump(data);
    await fs.writeFile(configPath, body, 'utf-8');
    return configPath;
  }

  it('serves repeated reads from the cache without re-parsing YAML', async () => {
    await writeConfigFile({ daemon: { port: 4000 } });

    // First call hits the disk; subsequent calls hit the cache.
    // We prove cache behavior by spying on file reads rather than relying
    // on object identity (the cache hands out clones, not the shared object
    // — see "isolated from caller mutation").
    const readFileSpy = vi.spyOn(fs, 'readFile');
    const first = await loadConfig();
    const callsAfterFirst = readFileSpy.mock.calls.length;
    const second = await loadConfig();
    const third = await loadConfig();

    expect(first.daemon?.port).toBe(4000);
    expect(second.daemon?.port).toBe(4000);
    expect(third.daemon?.port).toBe(4000);
    // No additional file reads after the first.
    expect(readFileSpy.mock.calls.length).toBe(callsAfterFirst);
  });

  it('loadConfigSync shares the same cache as loadConfig', async () => {
    await writeConfigFile({ daemon: { port: 5555 } });

    const fromAsync = await loadConfig();
    const fromSync = loadConfigSync();

    expect(fromAsync.daemon?.port).toBe(5555);
    expect(fromSync.daemon?.port).toBe(5555);
    // Sync read should reuse the async-loaded cache entry.
  });

  it('isolates callers from each other: mutating a returned config does not affect later reads', async () => {
    await writeConfigFile({ daemon: { port: 4000 } });

    const first = await loadConfig();
    // A caller mutates its private clone; the cached deployment input stays unchanged.
    first.daemon ??= {};
    first.daemon.port = 9999;

    const second = await loadConfig();
    // The cache returned a clone, so the mutation didn't leak.
    expect(second.daemon?.port).toBe(4000);
  });

  it('saveConfigForTests invalidates the cache so the next read returns the new value', async () => {
    await saveConfigForTests({ daemon: { port: 4000 } } as AgorConfig);
    const before = await loadConfig();
    expect(before.daemon?.port).toBe(4000);

    await saveConfigForTests({ daemon: { port: 9999 } } as AgorConfig);
    const after = await loadConfig();
    expect(after.daemon?.port).toBe(9999);
  });

  it('picks up external file mutations via mtime change', async () => {
    const configPath = await writeConfigFile({ daemon: { port: 4000 } });
    expect((await loadConfig()).daemon?.port).toBe(4000);

    // Force a distinct mtime — on filesystems with millisecond resolution,
    // back-to-back writes can collide.
    await new Promise((r) => setTimeout(r, 20));
    await fs.writeFile(configPath, yaml.dump({ daemon: { port: 7777 } }), 'utf-8');

    expect((await loadConfig()).daemon?.port).toBe(7777);
  });

  it('returns defaults when the file is missing, then re-reads after the file is created', async () => {
    // No file yet → defaults are cached under the NO_FILE sentinel.
    const before = await loadConfig();
    expect(before).toEqual(getDefaultConfig());

    // Create the file. The cached NO_FILE sentinel no longer matches stat,
    // so the next load re-reads.
    await writeConfigFile({ daemon: { port: 6666 } });
    const after = await loadConfig();
    expect(after.daemon?.port).toBe(6666);
  });

  it('does not poison the cache on parse error', async () => {
    await writeConfigFile('invalid: yaml: [content');

    await expect(loadConfig()).rejects.toThrow('Failed to load config');

    // After fixing the file, the next call should succeed (we never cached
    // a partial / broken value).
    await new Promise((r) => setTimeout(r, 20));
    await writeConfigFile({ daemon: { port: 8888 } });
    const recovered = await loadConfig();
    expect(recovered.daemon?.port).toBe(8888);
  });

  it('validates on every load path: loadConfigSync rejects removed values too', async () => {
    // Regression guard for the shared-cache bug: if loadConfigSync had a
    // separate (un-validated) code path, calling it first could populate
    // the cache with an invalid config that a later loadConfig() would
    // silently return.
    //
    // YAML written as a raw string because `unix_user_mode: 'opportunistic'`
    // is intentionally not assignable to `AgorConfig.execution.unix_user_mode`
    // (the value was removed from the type) — that's what
    // validateConfig() catches at runtime for users who still have the value
    // in their config.yaml.
    await writeConfigFile('execution:\n  unix_user_mode: opportunistic\n');

    expect(() => loadConfigSync()).toThrow(/opportunistic.*removed in Agor 0\.25\.0/s);
    // And async path stays consistent.
    await expect(loadConfig()).rejects.toThrow(/opportunistic.*removed in Agor 0\.25\.0/s);
  });

  it.each(['strict', 'insulated'])(
    'rejects removed %s mode with migration guidance',
    async (mode) => {
      await writeConfigFile(`execution:\n  unix_user_mode: ${mode}\n`);
      expect(() => loadConfigSync()).toThrow(
        new RegExp(`${mode}.*removed in Agor 0\\.25\\.0`, 's')
      );
      await expect(loadConfig()).rejects.toThrow(/latest Agor 0\.24\.x release/s);
    }
  );

  it.each(['executor_unix_user', 'sync_unix_passwords'])(
    'rejects removed host execution key %s',
    async (key) => {
      await writeConfigFile(`execution:\n  ${key}: legacy-value\n`);
      expect(() => loadConfigSync()).toThrow(new RegExp(`execution\\.${key}`));
      await expect(loadConfig()).rejects.toThrow(/removed host Unix execution/);
    }
  );

  it('rejects removed analytics module plugins on every load path', async () => {
    await writeConfigFile(
      'analytics:\n  enabled: false\n  plugins:\n    - type: module\n      enabled: false\n      options:\n        module_path: /opt/agor/plugin.js\n'
    );

    expect(() => loadConfigSync()).toThrow(
      /analytics\.plugins\[0\].*module.*removed.*stdout.*http_batch/s
    );
    await expect(loadConfig()).rejects.toThrow(
      /analytics\.plugins\[0\].*module.*removed.*stdout.*http_batch/s
    );
  });

  it('treats branch_rbac as app-level only in simple Unix mode', async () => {
    await writeConfigFile({
      execution: { branch_rbac: true, unix_user_mode: 'simple' },
    });

    expect(isBranchRbacEnabled()).toBe(true);
  });

  it.each([
    {
      name: 'open access simple',
      config: { execution: { branch_rbac: false, unix_user_mode: 'simple' } } as AgorConfig,
      expected: {
        appRbacEnabled: false,
        unixUserMode: 'simple',
        requiresExecutionHomeKey: false,
      },
    },
    {
      name: 'app RBAC simple',
      config: { execution: { branch_rbac: true, unix_user_mode: 'simple' } } as AgorConfig,
      expected: {
        appRbacEnabled: true,
        unixUserMode: 'simple',
        requiresExecutionHomeKey: false,
      },
    },
    {
      // Delegated requires per-user unix_username but performs no OS-level
      // work on the daemon host: no sudo and no host groups.
      name: 'delegated (identity enforced by execution substrate)',
      config: { execution: { branch_rbac: true, unix_user_mode: 'delegated' } } as AgorConfig,
      expected: {
        appRbacEnabled: true,
        unixUserMode: 'delegated',
        requiresExecutionHomeKey: true,
      },
    },
  ])('resolves execution security mode: $name', ({ config, expected }) => {
    expect(resolveExecutionSecurityMode(config)).toEqual(expected);
  });
});

describe('unixUserModeRequiresExecutionHomeKey', () => {
  it('requires a username only in delegated mode', () => {
    expect(unixUserModeRequiresExecutionHomeKey('simple')).toBe(false);
    expect(unixUserModeRequiresExecutionHomeKey('sandbox')).toBe(false);
    expect(unixUserModeRequiresExecutionHomeKey('delegated')).toBe(true);
  });
});

describe('base URL resolution', () => {
  let tempDir: string;
  let originalBaseUrl: string | undefined;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agor-base-url-'));
    vi.spyOn(os, 'homedir').mockReturnValue(tempDir);
    originalBaseUrl = process.env.AGOR_BASE_URL;
    delete process.env.AGOR_BASE_URL;
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
    if (originalBaseUrl === undefined) {
      delete process.env.AGOR_BASE_URL;
    } else {
      process.env.AGOR_BASE_URL = originalBaseUrl;
    }
  });

  it('returns AGOR_BASE_URL env when set', async () => {
    process.env.AGOR_BASE_URL = 'https://agor.example.com';
    await expect(getBaseUrl()).resolves.toBe('https://agor.example.com');
    await expect(getDaemonBaseUrl()).resolves.toBe('https://agor.example.com');
    await expect(requirePublicBaseUrl()).resolves.toBe('https://agor.example.com');
  });

  it('returns daemon.base_url from config when env is unset', async () => {
    const agorDir = path.join(tempDir, '.agor');
    await fs.mkdir(agorDir, { recursive: true });
    await fs.writeFile(
      path.join(agorDir, 'config.yaml'),
      yaml.dump({ daemon: { base_url: 'https://agor.sandbox.example.com' } }),
      'utf-8'
    );

    await expect(getBaseUrl()).resolves.toBe('https://agor.sandbox.example.com');
    await expect(getDaemonBaseUrl()).resolves.toBe('https://agor.sandbox.example.com');
    await expect(requirePublicBaseUrl()).resolves.toBe('https://agor.sandbox.example.com');
  });

  it('returns ui.base_url from legacy config when daemon.base_url is unset', async () => {
    const agorDir = path.join(tempDir, '.agor');
    await fs.mkdir(agorDir, { recursive: true });
    await fs.writeFile(
      path.join(agorDir, 'config.yaml'),
      yaml.dump({ ui: { base_url: 'https://agor-ui.sandbox.example.com' } }),
      'utf-8'
    );

    await expect(getBaseUrl()).resolves.toBe('https://agor-ui.sandbox.example.com');
    await expect(getDaemonBaseUrl()).resolves.toBe('https://agor-ui.sandbox.example.com');
    await expect(requirePublicBaseUrl()).resolves.toBe('https://agor-ui.sandbox.example.com');
  });

  it('separates UI links from daemon endpoints when both base URLs are configured', async () => {
    const agorDir = path.join(tempDir, '.agor');
    await fs.mkdir(agorDir, { recursive: true });
    await fs.writeFile(
      path.join(agorDir, 'config.yaml'),
      yaml.dump({
        daemon: { base_url: 'http://[::1]:3030' },
        ui: { base_url: 'http://localhost:5173' },
      }),
      'utf-8'
    );

    await expect(getBaseUrl()).resolves.toBe('http://localhost:5173');
    await expect(getDaemonBaseUrl()).resolves.toBe('http://[::1]:3030');
    await expect(requirePublicBaseUrl()).resolves.toBe('http://[::1]:3030');
  });

  it('throws PublicBaseUrlNotConfiguredError when neither env nor config is set', async () => {
    await expect(getBaseUrl()).resolves.toBe('http://localhost:3030');
    await expect(getDaemonBaseUrl()).resolves.toBe('http://localhost:3030');
    await expect(requirePublicBaseUrl()).rejects.toBeInstanceOf(PublicBaseUrlNotConfiguredError);
  });

  it('never silently falls back to localhost (regression: OAuth callback URL bug)', async () => {
    // Even with daemon.host / daemon.port configured, requirePublicBaseUrl must NOT
    // construct an http://{host}:{port} URL — that fallback is what caused remote
    // users to receive an unreachable localhost OAuth callback URL from upstream
    // providers like Notion.
    const agorDir = path.join(tempDir, '.agor');
    await fs.mkdir(agorDir, { recursive: true });
    await fs.writeFile(
      path.join(agorDir, 'config.yaml'),
      yaml.dump({ daemon: { host: 'localhost', port: 3030 } }),
      'utf-8'
    );

    await expect(requirePublicBaseUrl()).rejects.toBeInstanceOf(PublicBaseUrlNotConfiguredError);
  });

  it('strips a trailing slash from the configured base URL', async () => {
    process.env.AGOR_BASE_URL = 'https://agor.example.com/';
    await expect(requirePublicBaseUrl()).resolves.toBe('https://agor.example.com');
  });

  it('rejects a base URL without an http(s) scheme', async () => {
    process.env.AGOR_BASE_URL = 'agor.example.com';
    await expect(requirePublicBaseUrl()).rejects.toThrow(/must start with http/i);
  });
});

describe('saveConfigForTests', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agor-test-'));
    vi.spyOn(os, 'homedir').mockReturnValue(tempDir);
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('should save config to file', async () => {
    const config = createConfigData();
    await saveConfigForTests(config);

    const configPath = path.join(tempDir, '.agor', 'config.yaml');
    const content = await fs.readFile(configPath, 'utf-8');
    const loaded = yaml.load(content) as AgorConfig;

    expect(loaded).toMatchObject(config);
  });

  it('should create .agor directory if it does not exist', async () => {
    const config = createMinimalConfig();
    await saveConfigForTests(config);

    const agorDir = path.join(tempDir, '.agor');
    const stat = await fs.stat(agorDir);
    expect(stat.isDirectory()).toBe(true);
  });

  it('should overwrite existing config file', async () => {
    const config1 = createConfigData({ daemon: { port: 3030 } });
    const config2 = createConfigData({ daemon: { port: 4040 } });

    await saveConfigForTests(config1);
    await saveConfigForTests(config2);

    const loaded = await loadConfig();
    expect(loaded.daemon?.port).toBe(4040);
  });

  it('should save empty config', async () => {
    await saveConfigForTests({});

    const loaded = await loadConfig();
    expect(loaded).toEqual({});
  });

  it('validates external launch login redirect before saving', async () => {
    await expect(
      saveConfigForTests({
        external_launch: {
          enabled: true,
          login_redirect_url: 'javascript:alert(1)',
        },
      })
    ).rejects.toThrow(/external_launch\.login_redirect_url.*http/i);
  });

  it('should format YAML with proper indentation', async () => {
    const config = createConfigData();
    await saveConfigForTests(config);

    const configPath = path.join(tempDir, '.agor', 'config.yaml');
    const content = await fs.readFile(configPath, 'utf-8');

    // Check that content is properly indented (2 spaces)
    expect(content).toContain('daemon:');
    expect(content).toContain('  port: ');
    expect(content).not.toContain('    '); // No 4-space indents (we use 2)
  });
});

describe('initConfig', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agor-test-'));
    vi.spyOn(os, 'homedir').mockReturnValue(tempDir);
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('should create config file with defaults if not exists', async () => {
    await initConfig();

    const configPath = path.join(tempDir, '.agor', 'config.yaml');
    const exists = await fs
      .access(configPath)
      .then(() => true)
      .catch(() => false);

    expect(exists).toBe(true);

    const loaded = await loadConfig();
    expect(loaded).toEqual(getDefaultConfig());
  });

  it('should not overwrite existing config file', async () => {
    const customConfig = createConfigData();
    await saveConfigForTests(customConfig);

    await initConfig();

    const loaded = await loadConfig();
    expect(loaded).toMatchObject(customConfig);
    expect(loaded.daemon?.port).toBe(4000); // Custom value preserved
  });

  it('uses exclusive creation so concurrent initializers cannot race to overwrite', async () => {
    const results = await Promise.allSettled([
      createInitialConfig({ daemon: { port: 3001 } }),
      createInitialConfig({ daemon: { port: 3002 } }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected?.reason).toBeInstanceOf(ConfigAlreadyExistsError);
    expect([3001, 3002]).toContain((await loadConfig()).daemon?.port);
  });

  it('explains the filesystem requirement when atomic publication is unsupported', async () => {
    vi.spyOn(fs, 'link').mockRejectedValueOnce(
      Object.assign(new Error('hard links are unsupported'), { code: 'EOPNOTSUPP' })
    );

    let thrown: unknown;
    try {
      await createInitialConfig({ daemon: { port: 3001 } });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AtomicConfigPublicationUnsupportedError);
    expect(thrown).toMatchObject({
      name: 'AtomicConfigPublicationUnsupportedError',
      configPath: getConfigPath(),
      filesystemErrorCode: 'EOPNOTSUPP',
    });
    await expect(fs.access(getConfigPath())).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readdir(path.dirname(getConfigPath()))).toEqual([]);
  });

  it('preserves existing permission bits during an explicit atomic rewrite under any umask', async () => {
    await createInitialConfig({ daemon: { port: 3001 } });
    const configPath = getConfigPath();
    await fs.chmod(configPath, 0o640);
    const previousUmask = process.platform === 'win32' ? undefined : process.umask(0o077);
    try {
      await rewriteConfigForTests({ daemon: { port: 3002 } });
    } finally {
      if (previousUmask !== undefined) process.umask(previousUmask);
    }
    expect((await fs.stat(configPath)).mode & 0o777).toBe(0o640);
    expect((await loadConfig()).daemon?.port).toBe(3002);
  });
});

describe('getConfigValue', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agor-test-'));
    vi.spyOn(os, 'homedir').mockReturnValue(tempDir);
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('should get nested config value', async () => {
    const config = createConfigData();
    await saveConfigForTests(config);

    const value = await getConfigValue('daemon.port');
    expect(value).toBe(4000);
  });

  it('should return default value when not set in user config', async () => {
    await saveConfigForTests({}); // Empty config

    const value = await getConfigValue('daemon.port');
    expect(value).toBe(3030); // Default value
  });

  it('should merge user config with defaults', async () => {
    const partialConfig: AgorConfig = {
      daemon: { port: 9999 }, // Custom port
      // Other sections use defaults
    };
    await saveConfigForTests(partialConfig);

    const customValue = await getConfigValue('daemon.port');
    expect(customValue).toBe(9999);
    expect(await getConfigValue('display.tableStyle')).toBeUndefined();
  });

  it('should return undefined for non-existent keys', async () => {
    await saveConfigForTests({});

    const value = await getConfigValue('nonexistent.key');
    expect(value).toBeUndefined();
  });

  it('ignores retired settings from an existing config file', async () => {
    await saveConfigForTests({
      daemon: { allowAnonymous: false, requireAuth: true },
      defaults: { board: 'legacy', agent: 'legacy-agent' },
      display: { tableStyle: 'ascii', colorOutput: false },
      execution: { managed_envs_minimum_role: 'admin' },
      branches: { others_can_default: 'view', others_fs_access_default: 'none' },
      onboarding: { teammatePending: true },
    } as unknown as AgorConfig);

    expect(await getConfigValue('daemon.allowAnonymous')).toBeUndefined();
    expect(await getConfigValue('daemon.requireAuth')).toBeUndefined();
    expect(await getConfigValue('defaults.board')).toBeUndefined();
    expect(await getConfigValue('display.tableStyle')).toBeUndefined();
    expect(await getConfigValue('display.colorOutput')).toBeUndefined();
    expect(await getConfigValue('execution.managed_envs_minimum_role')).toBeUndefined();
    expect(await getConfigValue('branches.others_can_default')).toBeUndefined();
    expect(await getConfigValue('branches.others_fs_access_default')).toBeUndefined();
    expect(await getConfigValue('onboarding.teammatePending')).toBeUndefined();
  });

  it('should handle number values', async () => {
    const config = createConfigData({
      ui: { port: 9090, host: 'localhost' },
    });
    await saveConfigForTests(config);

    const port = await getConfigValue('ui.port');
    expect(port).toBe(9090);
  });
});

describe('getDaemonUrl', () => {
  let tempDir: string;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agor-test-'));
    vi.spyOn(os, 'homedir').mockReturnValue(tempDir);

    // Save original env
    originalEnv = { ...process.env };

    // Clear env vars that getDaemonUrl() consults so tests are isolated
    // from the developer's actual dev environment (e.g. when running tests
    // while the daemon is up on a non-default port).
    delete process.env.DAEMON_URL;
    delete process.env.PORT;
    delete process.env.AGOR_DAEMON_URL;
    delete process.env.AGOR_DAEMON_HOST;
    delete process.env.AGOR_DAEMON_PORT;
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();

    // Restore env
    process.env = originalEnv;
  });

  it('should construct URL from config', async () => {
    const config = createConfigData();
    await saveConfigForTests(config);

    const url = await getDaemonUrl();
    expect(url).toBe('http://0.0.0.0:4000');
  });

  it('should use defaults when config is empty', async () => {
    await saveConfigForTests({});

    const url = await getDaemonUrl();
    expect(url).toBe('http://localhost:3030');
  });

  it('should prioritize PORT env var over config', async () => {
    const config = createConfigData();
    await saveConfigForTests(config);

    process.env.PORT = '9999';

    const url = await getDaemonUrl();
    expect(url).toBe('http://0.0.0.0:9999'); // Port from env, host from config
  });

  it('should parse PORT env var as number', async () => {
    await saveConfigForTests({});
    process.env.PORT = '8080';

    const url = await getDaemonUrl();
    expect(url).toBe('http://localhost:8080');
  });

  it('should handle partial config with missing daemon section', async () => {
    const config: AgorConfig = {};
    await saveConfigForTests(config);

    const url = await getDaemonUrl();
    expect(url).toBe('http://localhost:3030'); // Fallback to defaults
  });

  it('should handle config with only custom port', async () => {
    const config: AgorConfig = {
      daemon: { port: 5000 },
      // No host specified
    };
    await saveConfigForTests(config);

    const url = await getDaemonUrl();
    expect(url).toBe('http://localhost:5000');
  });

  it('should handle config with only custom host', async () => {
    const config: AgorConfig = {
      daemon: { host: '192.168.1.1' },
      // No port specified
    };
    await saveConfigForTests(config);

    const url = await getDaemonUrl();
    expect(url).toBe('http://192.168.1.1:3030');
  });

  it('should prioritize DAEMON_URL env var over everything', async () => {
    const config = createConfigData();
    await saveConfigForTests(config);

    process.env.DAEMON_URL = 'https://custom-daemon.example.com:8443';

    const url = await getDaemonUrl();
    expect(url).toBe('https://custom-daemon.example.com:8443');
  });

  it('normalizes DAEMON_URL before any config consumer receives it', async () => {
    process.env.DAEMON_URL = ' HTTPS://Example.com:443/agor/// ';
    await expect(getDaemonUrl()).resolves.toBe('https://example.com/agor');
  });

  it.each([
    'https://user:secret@example.com',
    'https://example.com/?target=other',
    'https://example.com/#other',
  ])('rejects an unsafe DAEMON_URL override: %s', async (value) => {
    process.env.DAEMON_URL = value;
    await expect(getDaemonUrl()).rejects.toThrow('DAEMON_URL must not include');
  });
});

// =============================================================================
// Data Home Path Resolution Tests
// =============================================================================

describe('getDataHome', () => {
  let tempDir: string;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agor-test-'));
    vi.spyOn(os, 'homedir').mockReturnValue(tempDir);

    // Save original env
    originalEnv = { ...process.env };
    // Clear relevant env vars
    delete process.env.AGOR_DATA_HOME;
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();

    // Restore env
    process.env = originalEnv;
  });

  it('should default to AGOR_HOME (~/.agor) when no config or env var set', () => {
    const dataHome = getDataHome();
    expect(dataHome).toBe(path.join(tempDir, '.agor'));
  });

  it('should use paths.data_home from config when set', async () => {
    const config: AgorConfig = {
      paths: { data_home: '/data/agor' },
    };
    const agorDir = path.join(tempDir, '.agor');
    await fs.mkdir(agorDir, { recursive: true });
    await fs.writeFile(path.join(agorDir, 'config.yaml'), yaml.dump(config), 'utf-8');

    const dataHome = getDataHome();
    expect(dataHome).toBe('/data/agor');
  });

  it('should expand tilde in paths.data_home', async () => {
    const config: AgorConfig = {
      paths: { data_home: '~/custom-data' },
    };
    const agorDir = path.join(tempDir, '.agor');
    await fs.mkdir(agorDir, { recursive: true });
    await fs.writeFile(path.join(agorDir, 'config.yaml'), yaml.dump(config), 'utf-8');

    const dataHome = getDataHome();
    expect(dataHome).toBe(path.join(tempDir, 'custom-data'));
  });

  it('should prioritize AGOR_DATA_HOME env var over config', async () => {
    const config: AgorConfig = {
      paths: { data_home: '/config-path' },
    };
    const agorDir = path.join(tempDir, '.agor');
    await fs.mkdir(agorDir, { recursive: true });
    await fs.writeFile(path.join(agorDir, 'config.yaml'), yaml.dump(config), 'utf-8');

    process.env.AGOR_DATA_HOME = '/env-path';

    const dataHome = getDataHome();
    expect(dataHome).toBe('/env-path');
  });

  it('should expand tilde in AGOR_DATA_HOME env var', () => {
    process.env.AGOR_DATA_HOME = '~/env-data';

    const dataHome = getDataHome();
    expect(dataHome).toBe(path.join(tempDir, 'env-data'));
  });
});

describe('getReposDir', () => {
  let tempDir: string;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agor-test-'));
    vi.spyOn(os, 'homedir').mockReturnValue(tempDir);
    originalEnv = { ...process.env };
    delete process.env.AGOR_DATA_HOME;
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
    process.env = originalEnv;
  });

  it('should return repos path under data home', () => {
    const reposDir = getReposDir();
    expect(reposDir).toBe(path.join(tempDir, '.agor', 'repos'));
  });

  it('should use custom data_home for repos path', async () => {
    const config: AgorConfig = {
      paths: { data_home: '/custom/data' },
    };
    const agorDir = path.join(tempDir, '.agor');
    await fs.mkdir(agorDir, { recursive: true });
    await fs.writeFile(path.join(agorDir, 'config.yaml'), yaml.dump(config), 'utf-8');

    const reposDir = getReposDir();
    expect(reposDir).toBe('/custom/data/repos');
  });

  it('should use AGOR_DATA_HOME env var for repos path', () => {
    process.env.AGOR_DATA_HOME = '/env/data';

    const reposDir = getReposDir();
    expect(reposDir).toBe('/env/data/repos');
  });
});

describe('getTenantDataRoot', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agor-tenant-path-test-'));
    vi.spyOn(os, 'homedir').mockReturnValue(tempDir);
    delete process.env.AGOR_DATA_HOME;
    __resetConfigCacheForTests();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
    __resetConfigCacheForTests();
  });

  async function writeConfig(multi_tenancy: NonNullable<AgorConfig['multi_tenancy']>) {
    const agorDir = path.join(tempDir, '.agor');
    await fs.mkdir(agorDir, { recursive: true });
    await fs.writeFile(path.join(agorDir, 'config.yaml'), yaml.dump({ multi_tenancy }), 'utf-8');
    __resetConfigCacheForTests();
  }

  it('preserves the flat data root when multi-tenancy is disabled', () => {
    expect(getTenantDataRoot()).toBe(path.join(tempDir, '.agor'));
  });

  it('uses the default tenant base folder when enabled', async () => {
    await writeConfig({ filesystem_isolation_enabled: true });

    expect(getTenantDataRoot('tenant-a')).toBe(path.join(tempDir, '.agor', 'tenants', 'tenant-a'));
    expect(getReposDir('tenant-a')).toBe(
      path.join(tempDir, '.agor', 'tenants', 'tenant-a', 'repos')
    );
    expect(getBranchPath('org/repo', 'feature', 'tenant-a')).toBe(
      path.join(tempDir, '.agor', 'tenants', 'tenant-a', 'worktrees', 'org/repo', 'feature')
    );
  });

  it('resolves relative tenant base folders from the daemon home', async () => {
    await writeConfig({
      filesystem_isolation_enabled: true,
      tenants_base_folder: 'tenant-volume',
    });

    expect(getTenantDataRoot('tenant-b')).toBe(
      path.join(tempDir, '.agor', 'tenant-volume', 'tenant-b')
    );
  });

  it('supports absolute and home-relative tenant base folders', async () => {
    await writeConfig({
      filesystem_isolation_enabled: true,
      tenants_base_folder: '/data/agor-tenants',
    });
    expect(getTenantDataRoot('tenant-c')).toBe('/data/agor-tenants/tenant-c');

    await writeConfig({
      filesystem_isolation_enabled: true,
      tenants_base_folder: '~/mounted-tenants',
    });
    expect(getTenantDataRoot('tenant-c')).toBe(path.join(tempDir, 'mounted-tenants', 'tenant-c'));
  });

  it('requires a safe tenant id when enabled', async () => {
    await writeConfig({ filesystem_isolation_enabled: true });

    expect(() => getTenantDataRoot()).toThrow(/valid tenant id/i);
    expect(() => getTenantDataRoot('../escape')).toThrow(/valid tenant id/i);
  });

  it('fails closed instead of falling back to shared storage when config is invalid', async () => {
    const agorDir = path.join(tempDir, '.agor');
    await fs.mkdir(agorDir, { recursive: true });
    await fs.writeFile(
      path.join(agorDir, 'config.yaml'),
      yaml.dump({
        multi_tenancy: { filesystem_isolation_enabled: true, unsupported_option: true },
      }),
      'utf-8'
    );
    __resetConfigCacheForTests();

    expect(() => getTenantDataRoot('tenant-a')).toThrow(/unrecognized/i);
  });
});

describe('getBranchesDir', () => {
  let tempDir: string;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agor-test-'));
    vi.spyOn(os, 'homedir').mockReturnValue(tempDir);
    originalEnv = { ...process.env };
    delete process.env.AGOR_DATA_HOME;
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
    process.env = originalEnv;
  });

  it('should return branches path under data home', () => {
    const branchesDir = getBranchesDir();
    expect(branchesDir).toBe(path.join(tempDir, '.agor', 'worktrees'));
  });

  it('should use custom data_home for branches path', async () => {
    const config: AgorConfig = {
      paths: { data_home: '/custom/data' },
    };
    const agorDir = path.join(tempDir, '.agor');
    await fs.mkdir(agorDir, { recursive: true });
    await fs.writeFile(path.join(agorDir, 'config.yaml'), yaml.dump(config), 'utf-8');

    const branchesDir = getBranchesDir();
    expect(branchesDir).toBe('/custom/data/worktrees');
  });

  it('should use AGOR_DATA_HOME env var for branches path', () => {
    process.env.AGOR_DATA_HOME = '/env/data';

    const branchesDir = getBranchesDir();
    expect(branchesDir).toBe('/env/data/worktrees');
  });
});

describe('getBranchPath', () => {
  let tempDir: string;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agor-test-'));
    vi.spyOn(os, 'homedir').mockReturnValue(tempDir);
    originalEnv = { ...process.env };
    delete process.env.AGOR_DATA_HOME;
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
    process.env = originalEnv;
  });

  it('should construct branch path from repo slug and name', () => {
    const branchPath = getBranchPath('org/repo', 'feature-branch');
    expect(branchPath).toBe(path.join(tempDir, '.agor', 'worktrees', 'org/repo', 'feature-branch'));
  });

  it('should use custom data_home for branch path', async () => {
    const config: AgorConfig = {
      paths: { data_home: '/custom/data' },
    };
    const agorDir = path.join(tempDir, '.agor');
    await fs.mkdir(agorDir, { recursive: true });
    await fs.writeFile(path.join(agorDir, 'config.yaml'), yaml.dump(config), 'utf-8');

    const branchPath = getBranchPath('org/repo', 'feature-branch');
    expect(branchPath).toBe('/custom/data/worktrees/org/repo/feature-branch');
  });

  it('should use AGOR_DATA_HOME env var for branch path', () => {
    process.env.AGOR_DATA_HOME = '/env/data';

    const branchPath = getBranchPath('org/repo', 'feature-branch');
    expect(branchPath).toBe('/env/data/worktrees/org/repo/feature-branch');
  });
});

describe('resolveBranchStorageConfig + ensureBranchStorageModeAllowed', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agor-branch-storage-test-'));
    vi.spyOn(os, 'homedir').mockReturnValue(tempDir);
    __resetConfigCacheForTests();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
    __resetConfigCacheForTests();
  });

  async function writeConfig(config: AgorConfig): Promise<void> {
    const agorDir = path.join(tempDir, '.agor');
    await fs.mkdir(agorDir, { recursive: true });
    await fs.writeFile(path.join(agorDir, 'config.yaml'), yaml.dump(config), 'utf-8');
    __resetConfigCacheForTests();
  }

  it('defaults to both modes allowed with worktree as default when execution.branch_storage is not configured', () => {
    // No config file present. v0.20+ default exposes both modes in the UI /
    // MCP create tool while keeping `default_mode='worktree'` so callers that
    // don't pick a mode keep landing on the legacy path.
    const resolved = resolveBranchStorageConfig();
    expect(resolved).toEqual({
      defaultMode: 'worktree',
      allowedModes: ['worktree', 'clone'],
      allowShallowClones: true,
    });
  });

  it('lets operators disable clone mode by pinning allowed_modes to ["worktree"]', async () => {
    // Security-gradient deployments opt out of clone-mode entirely.
    await writeConfig({
      daemon: { port: 3030 },
      execution: {
        branch_storage: {
          allowed_modes: ['worktree'],
        },
      },
    });

    const resolved = resolveBranchStorageConfig();
    expect(resolved.allowedModes).toEqual(['worktree']);
    expect(() => ensureBranchStorageModeAllowed('clone')).toThrow(/not enabled/);
  });

  it('honours operator-configured allowed_modes + default_mode', async () => {
    await writeConfig({
      daemon: { port: 3030 },
      execution: {
        branch_storage: {
          default_mode: 'clone',
          allowed_modes: ['worktree', 'clone'],
        },
      },
    });

    const resolved = resolveBranchStorageConfig();
    expect(resolved.defaultMode).toBe('clone');
    expect(resolved.allowedModes).toEqual(['worktree', 'clone']);
  });

  it('can resolve the daemon-owned effective config without consulting ambient files', () => {
    const effectiveConfig: AgorConfig = {
      execution: {
        branch_storage: {
          default_mode: 'clone',
          allowed_modes: ['clone'],
          allow_shallow_clones: false,
        },
      },
    };

    expect(resolveBranchStorageConfig(effectiveConfig)).toEqual({
      defaultMode: 'clone',
      allowedModes: ['clone'],
      allowShallowClones: false,
    });
    expect(() => ensureBranchStorageModeAllowed('clone', effectiveConfig)).not.toThrow();
    expect(() => ensureBranchStorageModeAllowed('worktree', effectiveConfig)).toThrow(
      /not enabled/
    );
    expect(() => ensureBranchCloneDepthAllowed(1, effectiveConfig)).toThrow(/full clone/);
  });

  it('falls back default_mode into allowed_modes when operator misconfigures them', async () => {
    // Operator set default_mode: clone but forgot to add 'clone' to
    // allowed_modes. Resolver must not hand out a default that the gate
    // would immediately reject.
    await writeConfig({
      daemon: { port: 3030 },
      execution: {
        branch_storage: {
          default_mode: 'clone',
          allowed_modes: ['worktree'],
        },
      },
    });

    const resolved = resolveBranchStorageConfig();
    expect(resolved.defaultMode).toBe('worktree');
    expect(resolved.allowedModes).toEqual(['worktree']);
  });

  it('ensureBranchStorageModeAllowed throws a clear message for disallowed modes', async () => {
    // Pin allowed_modes to worktree-only to exercise the disallowed-clone path.
    await writeConfig({
      daemon: { port: 3030 },
      execution: {
        branch_storage: {
          allowed_modes: ['worktree'],
        },
      },
    });
    expect(() => ensureBranchStorageModeAllowed('worktree')).not.toThrow();
    expect(() => ensureBranchStorageModeAllowed('clone')).toThrow(/not enabled/);
    expect(() => ensureBranchStorageModeAllowed('clone')).toThrow(
      /execution\.branch_storage\.allowed_modes/
    );
  });

  it('ensureBranchStorageModeAllowed accepts both modes under the default config', () => {
    // v0.20+ default allows both — operators have to opt out to forbid clone.
    expect(() => ensureBranchStorageModeAllowed('worktree')).not.toThrow();
    expect(() => ensureBranchStorageModeAllowed('clone')).not.toThrow();
  });

  it('can require full clone-mode branches', async () => {
    await writeConfig({
      execution: {
        branch_storage: {
          default_mode: 'clone',
          allowed_modes: ['clone'],
          allow_shallow_clones: false,
        },
      },
    });

    expect(resolveBranchStorageConfig().allowShallowClones).toBe(false);
    expect(() => ensureBranchCloneDepthAllowed(undefined)).not.toThrow();
    expect(() => ensureBranchCloneDepthAllowed(1)).toThrow(/full clone/);
  });
});
