/**
 * Agor Config Manager
 *
 * Handles loading and saving YAML configuration file.
 */

import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import { DAEMON } from './constants';
import type { AgorConfig, UnknownJson } from './types';

/**
 * Get Agor home directory (~/.agor)
 */
export function getAgorHome(): string {
  return path.join(os.homedir(), '.agor');
}

/**
 * Get config file path (~/.agor/config.yaml)
 */
export function getConfigPath(): string {
  return path.join(getAgorHome(), 'config.yaml');
}

/**
 * Ensure ~/.agor directory exists
 */
async function ensureAgorHome(): Promise<void> {
  const agorHome = getAgorHome();
  try {
    await fs.access(agorHome);
  } catch {
    await fs.mkdir(agorHome, { recursive: true });
  }
}

/**
 * Load config from ~/.agor/config.yaml
 *
 * Returns default config if file doesn't exist.
 */
export async function loadConfig(): Promise<AgorConfig> {
  const configPath = getConfigPath();

  try {
    const content = await fs.readFile(configPath, 'utf-8');
    const config = yaml.load(content) as AgorConfig;
    return config || {};
  } catch (error) {
    // File doesn't exist or parse error - return default config
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return getDefaultConfig();
    }
    throw new Error(
      `Failed to load config: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Save config to ~/.agor/config.yaml
 */
export async function saveConfig(config: AgorConfig): Promise<void> {
  await ensureAgorHome();

  const configPath = getConfigPath();
  const content = yaml.dump(config, {
    indent: 2,
    lineWidth: 120,
    noRefs: true,
  });

  await fs.writeFile(configPath, content, 'utf-8');
}

/**
 * Get default config
 */
export function getDefaultConfig(): AgorConfig {
  return {
    defaults: {
      board: 'main',
      agent: 'claude-code',
    },
    display: {
      tableStyle: 'unicode',
      colorOutput: true,
      shortIdLength: 8,
    },
    daemon: {
      port: DAEMON.DEFAULT_PORT,
      host: DAEMON.DEFAULT_HOST,
      allowAnonymous: true, // Default: Allow anonymous access (local mode)
      requireAuth: false, // Default: Do not require authentication
      mcpEnabled: true, // Default: Enable built-in MCP server
    },
    ui: {
      port: 5173,
      host: 'localhost',
    },
    codex: {
      home: '~/.agor/codex',
    },
    execution: {
      session_token_expiration_ms: 86400000, // 24 hours
      session_token_max_uses: 1, // Single-use tokens
      sync_unix_passwords: true, // Default: sync passwords to Unix
    },
  };
}

/**
 * Expand a path that may start with ~/
 */
export function expandHomePath(input: string): string {
  if (!input) {
    return input;
  }
  if (input.startsWith('~/')) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

/**
 * Resolve configured Codex home directory (expanded to absolute path)
 */
export async function resolveCodexHome(): Promise<string> {
  const config = await loadConfig();
  const configured = config.codex?.home;
  const defaultHome = getDefaultConfig().codex?.home ?? '~/.agor/codex';
  const selected =
    typeof configured === 'string' && configured.trim().length > 0 ? configured : defaultHome;
  return expandHomePath(selected.trim());
}

/**
 * Ensure Codex home directory exists and return its absolute path.
 */
export async function ensureCodexHome(): Promise<string> {
  const home = await resolveCodexHome();
  await fs.mkdir(home, { recursive: true });
  return home;
}

/**
 * Initialize config file with defaults if it doesn't exist
 */
export async function initConfig(): Promise<void> {
  const configPath = getConfigPath();

  try {
    await fs.access(configPath);
    // File exists, don't overwrite
  } catch {
    // File doesn't exist, create with defaults
    await saveConfig(getDefaultConfig());
  }
}

/**
 * Get a nested config value using dot notation
 *
 * Merges with default config to return effective values.
 *
 * @param key - Config key (e.g., "credentials.ANTHROPIC_API_KEY")
 * @returns Value or undefined if not set
 */
export async function getConfigValue(key: string): Promise<string | boolean | number | undefined> {
  const config = await loadConfig();
  const defaults = getDefaultConfig();

  // Merge config with defaults (deep merge for sections)
  const merged = {
    ...defaults,
    ...config,
    defaults: { ...defaults.defaults, ...config.defaults },
    display: { ...defaults.display, ...config.display },
    daemon: { ...defaults.daemon, ...config.daemon },
    ui: { ...defaults.ui, ...config.ui },
    codex: { ...defaults.codex, ...config.codex },
    execution: { ...defaults.execution, ...config.execution },
  };

  const parts = key.split('.');

  let value: UnknownJson = merged;
  for (const part of parts) {
    if (value && typeof value === 'object' && part in value) {
      value = value[part];
    } else {
      return undefined;
    }
  }

  return value;
}

/**
 * Set a nested config value using dot notation
 *
 * @param key - Config key (e.g., "credentials.ANTHROPIC_API_KEY")
 * @param value - Value to set
 */
export async function setConfigValue(key: string, value: string | boolean | number): Promise<void> {
  const config = await loadConfig();
  const parts = key.split('.');

  if (parts.length === 1) {
    // Top-level key - not supported (all config is nested)
    throw new Error(
      `Top-level config keys not supported. Use format: section.key (e.g., defaults.${parts[0]})`
    );
  }

  // Nested key (e.g., "credentials.ANTHROPIC_API_KEY")
  const section = parts[0];

  if (!(config as UnknownJson)[section]) {
    (config as UnknownJson)[section] = {};
  }

  // Only support one level of nesting
  if (parts.length === 2) {
    (config as UnknownJson)[section][parts[1]] = value;
  } else {
    throw new Error(`Nested keys beyond one level not supported: ${key}`);
  }

  await saveConfig(config);
}

/**
 * Unset a nested config value using dot notation
 *
 * @param key - Config key to clear
 */
export async function unsetConfigValue(key: string): Promise<void> {
  const config = await loadConfig();
  const parts = key.split('.');

  if (parts.length === 1) {
    // Top-level key - not supported
    throw new Error(`Top-level config keys not supported. Use format: section.key`);
  }

  if (parts.length === 2) {
    const section = parts[0];
    const subKey = parts[1];

    if ((config as UnknownJson)[section] && subKey in (config as UnknownJson)[section]) {
      delete (config as UnknownJson)[section][subKey];
    }
  }

  await saveConfig(config);
}

/**
 * Get daemon URL from config
 *
 * Returns internal daemon URL for backend-to-backend communication.
 * Always returns localhost-based URL since all backend components (daemon, CLI, SDKs)
 * run in the same environment.
 *
 * For external access (browser UI), use frontend's getDaemonUrl() which detects
 * the appropriate public URL via window.location.
 *
 * @returns Daemon URL (e.g., "http://localhost:3030")
 */
export async function getDaemonUrl(): Promise<string> {
  // 1. Check for explicit DAEMON_URL env var (highest priority)
  if (process.env.DAEMON_URL) {
    return process.env.DAEMON_URL;
  }

  const config = await loadConfig();
  const defaults = getDefaultConfig();

  // 2. Build URL from config (with env var overrides for port)
  const envPort = process.env.PORT ? Number.parseInt(process.env.PORT, 10) : undefined;
  const port = envPort || config.daemon?.port || defaults.daemon?.port || DAEMON.DEFAULT_PORT;
  const host = config.daemon?.host || defaults.daemon?.host || DAEMON.DEFAULT_HOST;

  // 3. Construct from host:port (always localhost for internal communication)
  return `http://${host}:${port}`;
}

/**
 * Load config from ~/.agor/config.yaml (synchronous)
 *
 * Returns default config if file doesn't exist.
 * Use for hot paths where async is not possible.
 */
export function loadConfigSync(): AgorConfig {
  const configPath = getConfigPath();

  try {
    const content = readFileSync(configPath, 'utf-8');
    const config = yaml.load(content) as AgorConfig;
    return config || {};
  } catch (error) {
    // File doesn't exist or parse error - return default config
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return getDefaultConfig();
    }
    throw new Error(
      `Failed to load config: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Get credential with precedence: config.yaml > process.env
 *
 * This implements the rule that UI-set credentials (in config.yaml) take precedence
 * over environment variables. This allows users to override env vars via Settings UI.
 *
 * @param key - Credential key from CredentialKey enum
 * @returns API key or undefined
 */
export function getCredential(
  key: 'ANTHROPIC_API_KEY' | 'OPENAI_API_KEY' | 'GEMINI_API_KEY'
): string | undefined {
  try {
    const config = loadConfigSync();
    // Precedence: config.yaml > process.env
    return config.credentials?.[key] || process.env[key];
  } catch {
    // If config load fails, fall back to env var only
    return process.env[key];
  }
}

/**
 * Get the Unix user that the Agor daemon runs as.
 *
 * Resolution:
 * 1. If daemon.unix_user is configured, use it
 * 2. If Unix isolation enabled (worktree_rbac or unix_user_mode), require config
 * 3. Otherwise, fall back to current process user (dev mode)
 *
 * @param config - Agor configuration
 * @returns Unix username for the daemon
 * @throws Error if Unix isolation is enabled but daemon.unix_user is not configured
 *
 * @example
 * const config = await loadConfig();
 * const daemonUser = getAgorDaemonUser(config);
 */
export function getAgorDaemonUser(config: AgorConfig): string {
  // 1. If explicitly configured, always use it
  if (config.daemon?.unix_user) {
    return config.daemon.unix_user;
  }

  // 2. Check if Unix isolation is enabled - if so, require explicit config
  const unixIsolationEnabled =
    config.execution?.worktree_rbac === true ||
    (config.execution?.unix_user_mode && config.execution.unix_user_mode !== 'simple');

  if (unixIsolationEnabled) {
    throw new Error(
      'Unix isolation is enabled (worktree_rbac or unix_user_mode) but daemon.unix_user is not configured.\n' +
        'Please set daemon.unix_user in ~/.agor/config.yaml to the user running the daemon.\n' +
        'Example:\n' +
        '  daemon:\n' +
        '    unix_user: agor'
    );
  }

  // 3. Fall back to current process user (dev mode on Mac/Linux without isolation)
  const user = process.env.USER || os.userInfo().username;
  if (!user) {
    throw new Error(
      'Could not determine current user and daemon.unix_user is not configured.\n' +
        'Please set daemon.unix_user in ~/.agor/config.yaml.'
    );
  }
  return user;
}
