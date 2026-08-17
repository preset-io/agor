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
  assertValidEffectiveExecutionConfig,
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
  isUnixGroupRefreshNeeded,
  isUnixImpersonationEnabled,
  loadConfig,
  loadConfigSync,
  PublicBaseUrlNotConfiguredError,
  requireDaemonUser,
  requirePublicBaseUrl,
  resolveBranchStorageConfig,
  resolveEffectiveConfig,
  resolveExecutionSecurityMode,
  resolveTeammateFrameworkRepoUrl,
  rewriteConfigForTests,
  saveConfigForTests,
  unixUserModeRequiresUsername,
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
    expect(defaults.analytics?.enabled).toBe(false);
  });
});

describe('resolveEffectiveConfig', () => {
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

  it('keeps Unix executor impersonation opt-in while preserving explicit overrides', () => {
    expect(
      resolveEffectiveConfig(
        {},
        {
          AGOR_USE_EXECUTOR: 'false',
          AGOR_EXECUTOR_USERNAME: '',
        }
      ).execution?.executor_unix_user
    ).toBeUndefined();
    expect(
      resolveEffectiveConfig(
        {},
        {
          AGOR_USE_EXECUTOR: 'true',
          AGOR_EXECUTOR_USERNAME: '',
        }
      ).execution?.executor_unix_user
    ).toBe('agor_executor');
    expect(
      resolveEffectiveConfig(
        {},
        {
          AGOR_USE_EXECUTOR: 'false',
          AGOR_EXECUTOR_USERNAME: 'custom-runner',
        }
      ).execution?.executor_unix_user
    ).toBe('custom-runner');
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
});

describe('assertValidEffectiveExecutionConfig', () => {
  it.each(['strict', 'insulated'] as const)(
    'rejects sandboxing combined with %s Unix mode',
    (unix_user_mode) => {
      expect(() =>
        assertValidEffectiveExecutionConfig({
          execution: { unix_user_mode, sandbox: { enabled: true } },
        })
      ).toThrow(/incompatible/);
    }
  );

  it('rejects sandboxing combined with a local impersonation user', () => {
    expect(() =>
      assertValidEffectiveExecutionConfig({
        execution: {
          unix_user_mode: 'simple',
          executor_unix_user: 'agor_executor',
          sandbox: { enabled: true },
        },
      })
    ).toThrow(/executor_unix_user/);
  });

  it('rejects unsupported combinations introduced entirely by environment overrides', () => {
    const resolved = resolveEffectiveConfig(
      {},
      {
        AGOR_SANDBOX_ENABLED: 'true',
        AGOR_USE_EXECUTOR: 'true',
      }
    );
    expect(() => assertValidEffectiveExecutionConfig(resolved)).toThrow(/executor_unix_user/);
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

  it('loads the mcp_catalog block exactly as AGENTS.md documents it', async () => {
    // Read the block out of the docs rather than restating it. An unrecognized
    // top-level key throws, so documenting a section without registering it
    // makes every config load and every `agor config set` fail for anyone who
    // followed the instructions. Asserting the type exists would not catch it —
    // only exercising the load path does.
    const docs = await fs.readFile(path.resolve(__dirname, '../../../../AGENTS.md'), 'utf-8');
    const block = docs.match(/^mcp_catalog:\n(?:[ #].*\n)+/m)?.[0];
    expect(block, 'AGENTS.md no longer documents an mcp_catalog block').toBeDefined();

    const agorDir = path.join(tempDir, '.agor');
    await fs.mkdir(agorDir, { recursive: true });
    await fs.writeFile(path.join(agorDir, 'config.yaml'), block as string, 'utf-8');

    const loaded = await loadConfig();
    expect(loaded.mcp_catalog).toEqual({
      registry_sync_enabled: false,
      sync_interval_hours: 6,
      probe_budget: 40,
    });
  });

  it('round-trips every documented mcp_catalog key through save and load', async () => {
    // The write path re-validates. A key that loads but cannot be written back
    // is still unusable from the CLI, so the round trip is what matters.
    const agorDir = path.join(tempDir, '.agor');
    await fs.mkdir(agorDir, { recursive: true });

    await saveConfigForTests({
      mcp_catalog: {
        registry_sync_enabled: true,
        sync_interval_hours: 12,
        probe_budget: 5,
        registry_url: 'https://registry.internal',
      },
    } as AgorConfig);

    expect((await loadConfig()).mcp_catalog).toEqual({
      registry_sync_enabled: true,
      sync_interval_hours: 12,
      probe_budget: 5,
      registry_url: 'https://registry.internal',
    });
  });

  it('rejects an unknown mcp_catalog subkey rather than silently accepting it', async () => {
    // Every other section validates its subkeys; without an `only()` entry a
    // typo would be accepted and then silently ignored at runtime.
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
      yaml.dump({ daemon: { surprise: true }, execution: { branch_storage: { mystery: 1 } } }),
      'utf-8'
    );
    await expect(loadConfig()).rejects.toThrow(
      /daemon\.surprise.*execution\.branch_storage\.mystery/
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
    expect(loaded.external_launch?.login_redirect_url).toBe('https://workspace.example.com/open');
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

  it('validates on every load path: loadConfigSync rejects deprecated values too', async () => {
    // Regression guard for the shared-cache bug: if loadConfigSync had a
    // separate (un-validated) code path, calling it first could populate
    // the cache with an invalid config that a later loadConfig() would
    // silently return.
    //
    // YAML written as a raw string because `unix_user_mode: 'opportunistic'`
    // is intentionally not assignable to `AgorConfig.execution.unix_user_mode`
    // (the value was deprecated and removed from the type) — that's what
    // validateConfig() catches at runtime for users who still have the value
    // in their config.yaml.
    await writeConfigFile('execution:\n  unix_user_mode: opportunistic\n');

    expect(() => loadConfigSync()).toThrow(/opportunistic.*deprecated/s);
    // And async path stays consistent.
    await expect(loadConfig()).rejects.toThrow(/opportunistic.*deprecated/s);
  });

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
    expect(isUnixImpersonationEnabled()).toBe(false);
    expect(isUnixGroupRefreshNeeded()).toBe(false);
    expect(() => requireDaemonUser(loadConfigSync())).not.toThrow();
  });

  it('requires daemon.unix_user only for non-simple Unix modes', async () => {
    await writeConfigFile({
      execution: { branch_rbac: false, unix_user_mode: 'insulated' },
    });

    expect(isBranchRbacEnabled()).toBe(false);
    expect(isUnixImpersonationEnabled()).toBe(true);
    expect(isUnixGroupRefreshNeeded()).toBe(true);
    expect(() => requireDaemonUser(loadConfigSync())).toThrow(
      /execution\.unix_user_mode is insulated or strict/
    );
  });

  it.each([
    {
      name: 'open access simple',
      config: { execution: { branch_rbac: false, unix_user_mode: 'simple' } } as AgorConfig,
      expected: {
        appRbacEnabled: false,
        unixUserMode: 'simple',
        unixImpersonationEnabled: false,
        unixFsIsolationEnabled: false,
        unixGroupRefreshNeeded: false,
        requiresDaemonUnixUser: false,
        shouldInitUnixGroups: false,
        requiresUserUnixUsername: false,
      },
    },
    {
      name: 'app RBAC simple',
      config: { execution: { branch_rbac: true, unix_user_mode: 'simple' } } as AgorConfig,
      expected: {
        appRbacEnabled: true,
        unixUserMode: 'simple',
        unixImpersonationEnabled: false,
        unixFsIsolationEnabled: false,
        unixGroupRefreshNeeded: false,
        requiresDaemonUnixUser: false,
        shouldInitUnixGroups: false,
        requiresUserUnixUsername: false,
      },
    },
    {
      // Delegated requires per-user unix_username but performs no OS-level
      // work on the daemon host: no sudo, no groups, no daemon.unix_user.
      name: 'delegated (identity enforced by execution substrate)',
      config: { execution: { branch_rbac: true, unix_user_mode: 'delegated' } } as AgorConfig,
      expected: {
        appRbacEnabled: true,
        unixUserMode: 'delegated',
        unixImpersonationEnabled: false,
        unixFsIsolationEnabled: false,
        unixGroupRefreshNeeded: false,
        requiresDaemonUnixUser: false,
        shouldInitUnixGroups: false,
        requiresUserUnixUsername: true,
      },
    },
    {
      name: 'Unix insulated without app RBAC',
      config: { execution: { branch_rbac: false, unix_user_mode: 'insulated' } } as AgorConfig,
      expected: {
        appRbacEnabled: false,
        unixUserMode: 'insulated',
        unixImpersonationEnabled: true,
        unixFsIsolationEnabled: true,
        unixGroupRefreshNeeded: true,
        requiresDaemonUnixUser: true,
        shouldInitUnixGroups: true,
        requiresUserUnixUsername: false,
      },
    },
    {
      name: 'Unix strict with app RBAC',
      config: { execution: { branch_rbac: true, unix_user_mode: 'strict' } } as AgorConfig,
      expected: {
        appRbacEnabled: true,
        unixUserMode: 'strict',
        unixImpersonationEnabled: true,
        unixFsIsolationEnabled: true,
        unixGroupRefreshNeeded: true,
        requiresDaemonUnixUser: true,
        shouldInitUnixGroups: true,
        requiresUserUnixUsername: true,
      },
    },
  ])('resolves execution security mode: $name', ({ config, expected }) => {
    expect(resolveExecutionSecurityMode(config)).toEqual(expected);
  });
});

describe('unixUserModeRequiresUsername', () => {
  it('requires a username only in strict and delegated', () => {
    expect(unixUserModeRequiresUsername('simple')).toBe(false);
    expect(unixUserModeRequiresUsername('insulated')).toBe(false);
    expect(unixUserModeRequiresUsername('delegated')).toBe(true);
    expect(unixUserModeRequiresUsername('strict')).toBe(true);
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
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect([3001, 3002]).toContain((await loadConfig()).daemon?.port);
  });

  it('preserves existing permission bits during an explicit atomic rewrite', async () => {
    await createInitialConfig({ daemon: { port: 3001 } });
    const configPath = getConfigPath();
    await fs.chmod(configPath, 0o640);
    await rewriteConfigForTests({ daemon: { port: 3002 } });
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
