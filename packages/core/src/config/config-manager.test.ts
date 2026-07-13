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
  ensureBranchStorageModeAllowed,
  expandHomePath,
  getAgorHome,
  getBranchesDir,
  getBranchPath,
  getConfigPath,
  getConfigValue,
  getDaemonUrl,
  getDataHome,
  getDefaultConfig,
  getReposDir,
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
  resolveExecutionSecurityMode,
  saveConfig,
  setConfigValue,
  unsetConfigValue,
} from './config-manager';
import type { AgorConfig } from './types';

/**
 * Helper: Create test config data
 */
function createConfigData(overrides?: Partial<AgorConfig>): AgorConfig {
  return {
    defaults: {
      board: 'test-board',
      agent: 'test-agent',
    },
    display: {
      tableStyle: 'ascii',
      colorOutput: false,
    },
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
    expect(defaults.defaults?.board).toBe('main');
    expect(defaults.defaults?.agent).toBe('claude-code');
    expect(defaults.display?.tableStyle).toBe('unicode');
    expect(defaults.display?.colorOutput).toBe(true);
    expect(defaults.daemon?.port).toBe(3030);
    expect(defaults.daemon?.host).toBe('localhost');
    expect(defaults.ui?.port).toBe(5173);
    expect(defaults.ui?.host).toBe('localhost');
    expect(defaults.analytics?.enabled).toBe(false);
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

  it('should return default config when file does not exist', async () => {
    const loaded = await loadConfig();
    const defaults = getDefaultConfig();
    expect(loaded).toEqual(defaults);
  });

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

  it.each([
    'resources',
    'services',
    'credentials',
    'opencode',
  ])('rejects the removed %s config surface', async (key) => {
    const agorDir = path.join(tempDir, '.agor');
    const configPath = path.join(agorDir, 'config.yaml');
    await fs.mkdir(agorDir, { recursive: true });
    await fs.writeFile(configPath, yaml.dump({ [key]: {} }), 'utf-8');

    await expect(loadConfig()).rejects.toThrow(new RegExp(`'${key}' has been removed`));
  });

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
        display: { shortIdLength: 12 },
      }),
      'utf-8'
    );
    await expect(loadConfig()).resolves.toMatchObject({
      daemon: { allowAnonymous: false, requireAuth: true },
      display: { shortIdLength: 12 },
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
    expect(loaded.defaults).toBeUndefined();
    expect(loaded.display).toBeUndefined();
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
    // Caller mutates the returned object (mimicking setConfigValue style).
    first.daemon ??= {};
    first.daemon.port = 9999;

    const second = await loadConfig();
    // The cache returned a clone, so the mutation didn't leak.
    expect(second.daemon?.port).toBe(4000);
  });

  it('saveConfig invalidates the cache so the next read returns the new value', async () => {
    await saveConfig({ daemon: { port: 4000 } } as AgorConfig);
    const before = await loadConfig();
    expect(before.daemon?.port).toBe(4000);

    await saveConfig({ daemon: { port: 9999 } } as AgorConfig);
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
      },
    },
  ])('resolves execution security mode: $name', ({ config, expected }) => {
    expect(resolveExecutionSecurityMode(config)).toEqual(expected);
  });
});

describe('requirePublicBaseUrl', () => {
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

    await expect(requirePublicBaseUrl()).resolves.toBe('https://agor-ui.sandbox.example.com');
  });

  it('throws PublicBaseUrlNotConfiguredError when neither env nor config is set', async () => {
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

describe('saveConfig', () => {
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
    await saveConfig(config);

    const configPath = path.join(tempDir, '.agor', 'config.yaml');
    const content = await fs.readFile(configPath, 'utf-8');
    const loaded = yaml.load(content) as AgorConfig;

    expect(loaded).toMatchObject(config);
  });

  it('should create .agor directory if it does not exist', async () => {
    const config = createMinimalConfig();
    await saveConfig(config);

    const agorDir = path.join(tempDir, '.agor');
    const stat = await fs.stat(agorDir);
    expect(stat.isDirectory()).toBe(true);
  });

  it('should overwrite existing config file', async () => {
    const config1 = createConfigData({ daemon: { port: 3030 } });
    const config2 = createConfigData({ daemon: { port: 4040 } });

    await saveConfig(config1);
    await saveConfig(config2);

    const loaded = await loadConfig();
    expect(loaded.daemon?.port).toBe(4040);
  });

  it('should save empty config', async () => {
    await saveConfig({});

    const loaded = await loadConfig();
    expect(loaded).toEqual({});
  });

  it('validates external launch login redirect before saving', async () => {
    await expect(
      saveConfig({
        external_launch: {
          enabled: true,
          login_redirect_url: 'javascript:alert(1)',
        },
      })
    ).rejects.toThrow(/external_launch\.login_redirect_url.*http/i);
  });

  it('should format YAML with proper indentation', async () => {
    const config = createConfigData();
    await saveConfig(config);

    const configPath = path.join(tempDir, '.agor', 'config.yaml');
    const content = await fs.readFile(configPath, 'utf-8');

    // Check that content is properly indented (2 spaces)
    expect(content).toContain('defaults:');
    expect(content).toContain('  board: ');
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
    await saveConfig(customConfig);

    await initConfig();

    const loaded = await loadConfig();
    expect(loaded).toMatchObject(customConfig);
    expect(loaded.daemon?.port).toBe(4000); // Custom value preserved
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
    await saveConfig(config);

    const value = await getConfigValue('daemon.port');
    expect(value).toBe(4000);
  });

  it('should return default value when not set in user config', async () => {
    await saveConfig({}); // Empty config

    const value = await getConfigValue('daemon.port');
    expect(value).toBe(3030); // Default value
  });

  it('should merge user config with defaults', async () => {
    const partialConfig: AgorConfig = {
      daemon: { port: 9999 }, // Custom port
      // Other sections use defaults
    };
    await saveConfig(partialConfig);

    const customValue = await getConfigValue('daemon.port');
    const defaultValue = await getConfigValue('display.tableStyle');

    expect(customValue).toBe(9999);
    expect(defaultValue).toBe('unicode'); // From defaults
  });

  it('should return undefined for non-existent keys', async () => {
    await saveConfig({});

    const value = await getConfigValue('nonexistent.key');
    expect(value).toBeUndefined();
  });

  it('should handle boolean values', async () => {
    const config = createConfigData();
    await saveConfig(config);

    const colorOutput = await getConfigValue('display.colorOutput');
    expect(colorOutput).toBe(false);
  });

  it('should handle string values', async () => {
    const config = createConfigData();
    await saveConfig(config);

    const tableStyle = await getConfigValue('display.tableStyle');
    expect(tableStyle).toBe('ascii');
  });

  it('should handle number values', async () => {
    const config = createConfigData({
      ui: { port: 9090, host: 'localhost' },
    });
    await saveConfig(config);

    const port = await getConfigValue('ui.port');
    expect(port).toBe(9090);
  });
});

describe('setConfigValue', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agor-test-'));
    vi.spyOn(os, 'homedir').mockReturnValue(tempDir);
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('should set nested config value', async () => {
    await saveConfig({});
    await setConfigValue('daemon.port', 8888);

    const value = await getConfigValue('daemon.port');
    expect(value).toBe(8888);
  });

  it('should create section if it does not exist', async () => {
    await saveConfig({});
    await setConfigValue('onboarding.teammatePending', true);

    const loaded = await loadConfig();
    expect(loaded.onboarding?.teammatePending).toBe(true);
  });

  it('should update existing value', async () => {
    const config = createConfigData();
    await saveConfig(config);

    await setConfigValue('daemon.port', 7777);

    const value = await getConfigValue('daemon.port');
    expect(value).toBe(7777);
  });

  it('should handle string values', async () => {
    await saveConfig({});
    await setConfigValue('defaults.board', 'custom-board');

    const value = await getConfigValue('defaults.board');
    expect(value).toBe('custom-board');
  });

  it('should handle boolean values', async () => {
    await saveConfig({});
    await setConfigValue('daemon.mcpEnabled', false);

    const value = await getConfigValue('daemon.mcpEnabled');
    expect(value).toBe(false);
  });

  it('should handle number values', async () => {
    await saveConfig({});
    await setConfigValue('ui.port', 9090);

    const value = await getConfigValue('ui.port');
    expect(value).toBe(9090);
  });

  it('should throw error for top-level keys', async () => {
    await saveConfig({});

    await expect(setConfigValue('topLevel', 'value')).rejects.toThrow(
      'Top-level config keys not supported'
    );
  });

  it('should throw error for deeply nested keys', async () => {
    await saveConfig({});

    await expect(setConfigValue('section.subsection.deep', 'value')).rejects.toThrow(
      'Nested keys beyond one level not supported'
    );
  });

  it('should preserve other sections when setting value', async () => {
    const config = createConfigData();
    await saveConfig(config);

    await setConfigValue('daemon.port', 5555);

    const loaded = await loadConfig();
    expect(loaded.daemon?.port).toBe(5555);
    expect(loaded.display).toMatchObject(config.display!);
    expect(loaded.defaults).toMatchObject(config.defaults!);
  });
});

describe('unsetConfigValue', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agor-test-'));
    vi.spyOn(os, 'homedir').mockReturnValue(tempDir);
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('should unset existing config value', async () => {
    const config = createConfigData();
    await saveConfig(config);

    await unsetConfigValue('daemon.port');

    const loaded = await loadConfig();
    expect(loaded.daemon?.port).toBeUndefined();
  });

  it('should not error when unsetting non-existent key', async () => {
    await saveConfig({});

    await expect(unsetConfigValue('daemon.nonExistent')).resolves.not.toThrow();
  });

  it('should not error when unsetting from non-existent section', async () => {
    await saveConfig({});

    await expect(unsetConfigValue('onboarding.someUnknownKey')).resolves.not.toThrow();
  });

  it('should preserve other keys in same section', async () => {
    const config = createConfigData();
    await saveConfig(config);

    await unsetConfigValue('daemon.port');

    const loaded = await loadConfig();
    expect(loaded.daemon?.port).toBeUndefined();
    expect(loaded.daemon?.host).toBe('0.0.0.0'); // Preserved
  });

  it('should preserve other sections', async () => {
    const config = createConfigData();
    await saveConfig(config);

    await unsetConfigValue('daemon.port');

    const loaded = await loadConfig();
    expect(loaded.display).toMatchObject(config.display!);
    expect(loaded.defaults).toMatchObject(config.defaults!);
  });

  it('should throw error for top-level keys', async () => {
    await saveConfig({});

    await expect(unsetConfigValue('topLevel')).rejects.toThrow(
      'Top-level config keys not supported'
    );
  });

  it('should handle unsetting deeply nested keys gracefully', async () => {
    await saveConfig({});

    // Should not throw, just no-op since only 2-level nesting is supported
    await expect(unsetConfigValue('section.sub.deep')).resolves.not.toThrow();
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
    await saveConfig(config);

    const url = await getDaemonUrl();
    expect(url).toBe('http://0.0.0.0:4000');
  });

  it('should use defaults when config is empty', async () => {
    await saveConfig({});

    const url = await getDaemonUrl();
    expect(url).toBe('http://localhost:3030');
  });

  it('should prioritize PORT env var over config', async () => {
    const config = createConfigData();
    await saveConfig(config);

    process.env.PORT = '9999';

    const url = await getDaemonUrl();
    expect(url).toBe('http://0.0.0.0:9999'); // Port from env, host from config
  });

  it('should parse PORT env var as number', async () => {
    await saveConfig({});
    process.env.PORT = '8080';

    const url = await getDaemonUrl();
    expect(url).toBe('http://localhost:8080');
  });

  it('should handle partial config with missing daemon section', async () => {
    const config: AgorConfig = {
      defaults: { board: 'main' },
      // No daemon section
    };
    await saveConfig(config);

    const url = await getDaemonUrl();
    expect(url).toBe('http://localhost:3030'); // Fallback to defaults
  });

  it('should handle config with only custom port', async () => {
    const config: AgorConfig = {
      daemon: { port: 5000 },
      // No host specified
    };
    await saveConfig(config);

    const url = await getDaemonUrl();
    expect(url).toBe('http://localhost:5000');
  });

  it('should handle config with only custom host', async () => {
    const config: AgorConfig = {
      daemon: { host: '192.168.1.1' },
      // No port specified
    };
    await saveConfig(config);

    const url = await getDaemonUrl();
    expect(url).toBe('http://192.168.1.1:3030');
  });

  it('should prioritize DAEMON_URL env var over everything', async () => {
    const config = createConfigData();
    await saveConfig(config);

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
});
