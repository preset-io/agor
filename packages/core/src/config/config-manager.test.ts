/**
 * Tests for Agor Config Manager
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ensureCodexHome,
  expandHomePath,
  getAgorHome,
  getConfigPath,
  getConfigValue,
  getDaemonUrl,
  getDataHome,
  getDefaultConfig,
  getReposDir,
  getWorktreePath,
  getWorktreesDir,
  initConfig,
  loadConfig,
  resolveCodexHome,
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
      shortIdLength: 12,
    },
    daemon: {
      port: 4000,
      host: '0.0.0.0',
      allowAnonymous: false,
      requireAuth: true,
    },
    ui: {
      port: 8080,
      host: '127.0.0.1',
    },
    credentials: {
      ANTHROPIC_API_KEY: 'test-key-123',
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
    expect(defaults.display?.shortIdLength).toBe(8);
    expect(defaults.daemon?.port).toBe(3030);
    expect(defaults.daemon?.host).toBe('localhost');
    expect(defaults.daemon?.allowAnonymous).toBe(true);
    expect(defaults.daemon?.requireAuth).toBe(false);
    expect(defaults.ui?.port).toBe(5173);
    expect(defaults.ui?.host).toBe('localhost');
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
});

describe('resolveCodexHome & ensureCodexHome', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agor-config-'));
    vi.spyOn(os, 'homedir').mockReturnValue(tempDir);
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('should resolve to default Codex home when not configured', async () => {
    const home = await resolveCodexHome();
    expect(home).toBe(path.join(tempDir, '.agor', 'codex'));
  });

  it('should resolve a configured tilde path', async () => {
    const agorDir = path.join(tempDir, '.agor');
    await fs.mkdir(agorDir, { recursive: true });
    await fs.writeFile(
      path.join(agorDir, 'config.yaml'),
      yaml.dump({ codex: { home: '~/.custom-codex' } }),
      'utf-8'
    );

    const home = await resolveCodexHome();
    expect(home).toBe(path.join(tempDir, '.custom-codex'));
  });

  it('should create the default Codex home directory when ensuring', async () => {
    const codexHome = await ensureCodexHome();
    expect(codexHome).toBe(path.join(tempDir, '.agor', 'codex'));
    const stats = await fs.stat(codexHome);
    expect(stats.isDirectory()).toBe(true);
  });

  it('should create a configured Codex home directory if missing', async () => {
    const customHome = path.join(tempDir, 'codex-data');
    const agorDir = path.join(tempDir, '.agor');
    await fs.mkdir(agorDir, { recursive: true });
    await fs.writeFile(
      path.join(agorDir, 'config.yaml'),
      yaml.dump({ codex: { home: customHome } }),
      'utf-8'
    );

    const codexHome = await ensureCodexHome();
    expect(codexHome).toBe(customHome);
    const stats = await fs.stat(customHome);
    expect(stats.isDirectory()).toBe(true);
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

  it('should handle credentials key', async () => {
    const config = createConfigData();
    await saveConfig(config);

    const apiKey = await getConfigValue('credentials.ANTHROPIC_API_KEY');
    expect(apiKey).toBe('test-key-123');
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
    const config = createConfigData();
    await saveConfig(config);

    const shortIdLength = await getConfigValue('display.shortIdLength');
    expect(shortIdLength).toBe(12);
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
    await setConfigValue('credentials.ANTHROPIC_API_KEY', 'new-key');

    const loaded = await loadConfig();
    expect(loaded.credentials?.ANTHROPIC_API_KEY).toBe('new-key');
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
    await setConfigValue('daemon.allowAnonymous', false);

    const value = await getConfigValue('daemon.allowAnonymous');
    expect(value).toBe(false);
  });

  it('should handle number values', async () => {
    await saveConfig({});
    await setConfigValue('display.shortIdLength', 16);

    const value = await getConfigValue('display.shortIdLength');
    expect(value).toBe(16);
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

    await expect(unsetConfigValue('credentials.SOME_KEY')).resolves.not.toThrow();
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

describe('getWorktreesDir', () => {
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

  it('should return worktrees path under data home', () => {
    const worktreesDir = getWorktreesDir();
    expect(worktreesDir).toBe(path.join(tempDir, '.agor', 'worktrees'));
  });

  it('should use custom data_home for worktrees path', async () => {
    const config: AgorConfig = {
      paths: { data_home: '/custom/data' },
    };
    const agorDir = path.join(tempDir, '.agor');
    await fs.mkdir(agorDir, { recursive: true });
    await fs.writeFile(path.join(agorDir, 'config.yaml'), yaml.dump(config), 'utf-8');

    const worktreesDir = getWorktreesDir();
    expect(worktreesDir).toBe('/custom/data/worktrees');
  });

  it('should use AGOR_DATA_HOME env var for worktrees path', () => {
    process.env.AGOR_DATA_HOME = '/env/data';

    const worktreesDir = getWorktreesDir();
    expect(worktreesDir).toBe('/env/data/worktrees');
  });
});

describe('getWorktreePath', () => {
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

  it('should construct worktree path from repo slug and name', () => {
    const worktreePath = getWorktreePath('org/repo', 'feature-branch');
    expect(worktreePath).toBe(
      path.join(tempDir, '.agor', 'worktrees', 'org/repo', 'feature-branch')
    );
  });

  it('should use custom data_home for worktree path', async () => {
    const config: AgorConfig = {
      paths: { data_home: '/custom/data' },
    };
    const agorDir = path.join(tempDir, '.agor');
    await fs.mkdir(agorDir, { recursive: true });
    await fs.writeFile(path.join(agorDir, 'config.yaml'), yaml.dump(config), 'utf-8');

    const worktreePath = getWorktreePath('org/repo', 'feature-branch');
    expect(worktreePath).toBe('/custom/data/worktrees/org/repo/feature-branch');
  });

  it('should use AGOR_DATA_HOME env var for worktree path', () => {
    process.env.AGOR_DATA_HOME = '/env/data';

    const worktreePath = getWorktreePath('org/repo', 'feature-branch');
    expect(worktreePath).toBe('/env/data/worktrees/org/repo/feature-branch');
  });
});
