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
import { DAEMON, MCP_TOKEN } from './constants';
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
 * Validate config and throw helpful errors for deprecated/invalid settings
 */
function validateConfig(config: AgorConfig): void {
  // Check for deprecated 'opportunistic' unix_user_mode
  const mode = config.execution?.unix_user_mode;
  if (mode === ('opportunistic' as never)) {
    throw new Error(
      `Config error: 'opportunistic' unix_user_mode has been deprecated.\n` +
        `Please update your config to use one of:\n` +
        `  - 'insulated': Filesystem isolation via Unix groups (recommended)\n` +
        `  - 'strict': Full process impersonation required\n` +
        `\n` +
        `To update: agor config set execution.unix_user_mode insulated`
    );
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
    const finalConfig = config || {};
    validateConfig(finalConfig);
    return finalConfig;
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
 * Load config from a specific file path.
 *
 * Unlike loadConfig(), this does NOT fall back to defaults if the file is missing.
 * Throws on missing file or parse error.
 */
export async function loadConfigFromFile(filePath: string): Promise<AgorConfig> {
  const content = await fs.readFile(filePath, 'utf-8');
  const config = yaml.load(content) as AgorConfig;
  const finalConfig = config || {};
  validateConfig(finalConfig);
  return finalConfig;
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
    execution: {
      session_token_expiration_ms: 86400000, // 24 hours
      session_token_max_uses: 1, // Single-use tokens
      mcp_token_expiration_ms: MCP_TOKEN.DEFAULT_EXPIRATION_MS,
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
    execution: { ...defaults.execution, ...config.execution },
    paths: { ...defaults.paths, ...config.paths },
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
    console.log('[getDaemonUrl] Using DAEMON_URL from env:', process.env.DAEMON_URL);
    return process.env.DAEMON_URL;
  }

  console.log('[getDaemonUrl] DAEMON_URL not in env, loading config...');
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
 * Validate and normalize a base URL
 *
 * @param url - URL to validate
 * @returns Normalized URL without trailing slash
 * @throws Error if URL is invalid or uses unsupported scheme
 */
function validateBaseUrl(url: string): string {
  const trimmed = url.trim().replace(/\/$/, ''); // Remove trailing slash and whitespace

  // Basic validation: must start with http:// or https://
  if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) {
    throw new Error(`Invalid base URL: "${url}". Must start with http:// or https://`);
  }

  // Additional validation: ensure it's a valid URL structure
  try {
    new URL(trimmed);
  } catch {
    throw new Error(`Invalid base URL format: "${url}". Must be a valid HTTP(S) URL.`);
  }

  return trimmed;
}

/**
 * Get base URL for external/user-facing links
 *
 * Used to generate clickable URLs to sessions, boards, and other resources
 * that are sent to external platforms like Slack, email, etc.
 *
 * Resolution order:
 * 1. AGOR_BASE_URL environment variable (highest priority)
 * 2. daemon.base_url from config.yaml
 * 3. Default: http://localhost:{port} (constructed from daemon port)
 *
 * @returns Base URL without trailing slash (e.g., "https://agor.sandbox.preset.zone")
 */
export async function getBaseUrl(): Promise<string> {
  // 1. Check for explicit AGOR_BASE_URL env var (highest priority)
  if (process.env.AGOR_BASE_URL) {
    return validateBaseUrl(process.env.AGOR_BASE_URL);
  }

  const config = await loadConfig();

  // 2. Check config.yaml
  if (config.daemon?.base_url) {
    return validateBaseUrl(config.daemon.base_url);
  }

  // 3. Default: construct from daemon port (no validation needed for default)
  const defaults = getDefaultConfig();
  const envPort = process.env.PORT ? Number.parseInt(process.env.PORT, 10) : undefined;
  const port = envPort || config.daemon?.port || defaults.daemon?.port || DAEMON.DEFAULT_PORT;
  const host = config.daemon?.host || defaults.daemon?.host || DAEMON.DEFAULT_HOST;

  return `http://${host}:${port}`;
}

/**
 * Error thrown by {@link requirePublicBaseUrl} when no public base URL is configured.
 *
 * Carries a stable `code` so callers (e.g. OAuth start endpoint) can distinguish a
 * missing-config failure from other unexpected errors and surface a clean,
 * actionable message to the UI.
 */
export class PublicBaseUrlNotConfiguredError extends Error {
  readonly code = 'PUBLIC_BASE_URL_NOT_CONFIGURED' as const;

  constructor(message: string) {
    super(message);
    this.name = 'PublicBaseUrlNotConfiguredError';
  }
}

/**
 * Get the daemon's public, browser-reachable base URL.
 *
 * Strict variant of {@link getBaseUrl} — required for any URL that will be handed
 * to a remote system (e.g. an OAuth `redirect_uri` registered with an upstream
 * provider) and then loaded by an end-user's browser.
 *
 * Resolution:
 * 1. `AGOR_BASE_URL` environment variable
 * 2. `daemon.base_url` from `~/.agor/config.yaml`
 * 3. **Throws** {@link PublicBaseUrlNotConfiguredError}
 *
 * Unlike {@link getBaseUrl}, this never silently falls back to
 * `http://localhost:{port}` — that fallback is broken for any browser not on
 * the daemon's host (e.g. a remote user of a deployed Agor instance), and
 * results in OAuth providers redirecting to an unreachable URL.
 *
 * @returns Base URL without trailing slash (e.g., "https://agor.sandbox.preset.zone")
 * @throws {PublicBaseUrlNotConfiguredError} if neither source is set
 */
export async function requirePublicBaseUrl(): Promise<string> {
  if (process.env.AGOR_BASE_URL) {
    return validateBaseUrl(process.env.AGOR_BASE_URL);
  }

  const config = await loadConfig();
  if (config.daemon?.base_url) {
    return validateBaseUrl(config.daemon.base_url);
  }

  throw new PublicBaseUrlNotConfiguredError(
    'No public base URL configured. Set the AGOR_BASE_URL environment variable ' +
      "or `daemon.base_url` in ~/.agor/config.yaml to the daemon's " +
      'browser-reachable URL (e.g. https://agor.example.com). This is required ' +
      'so OAuth providers can redirect users back to a URL their browser can reach — ' +
      'the localhost fallback only works for browsers on the daemon machine.'
  );
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
 * Credential keys that are valid in `config.yaml`'s `credentials` section
 * (i.e., keys that have a meaningful global / app-level value). User-only
 * tokens like `CLAUDE_CODE_OAUTH_TOKEN` (Pro/Max subscription) and
 * `COPILOT_GITHUB_TOKEN` are intentionally excluded — they don't make sense
 * as a global default.
 */
export type ConfigCredentialKey =
  | 'ANTHROPIC_API_KEY'
  | 'ANTHROPIC_AUTH_TOKEN'
  | 'ANTHROPIC_BASE_URL'
  | 'OPENAI_API_KEY'
  | 'GEMINI_API_KEY';

const CONFIG_CREDENTIAL_KEYS: ReadonlySet<string> = new Set<ConfigCredentialKey>([
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
]);

export function isConfigCredentialKey(key: string): key is ConfigCredentialKey {
  return CONFIG_CREDENTIAL_KEYS.has(key);
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
export function getCredential(key: ConfigCredentialKey): string | undefined {
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
 * Get the Unix user that the Agor daemon runs as
 *
 * Resolution order:
 * 1. daemon.unix_user from config (explicit configuration)
 * 2. Current process user (development mode fallback)
 *
 * Used for:
 * - Git operations with fresh group memberships (sudo su -)
 * - Unix integration service initialization
 * - Terminal impersonation decisions
 *
 * @returns Unix username, or undefined if not determinable
 *
 * @example
 * ```ts
 * const daemonUser = getDaemonUser();
 * if (daemonUser && isWorktreeRbacEnabled()) {
 *   runAsUser('git status', { asUser: daemonUser });
 * }
 * ```
 */
export function getDaemonUser(): string | undefined {
  try {
    const config = loadConfigSync();
    if (config.daemon?.unix_user) {
      return config.daemon.unix_user;
    }
    // Fall back to current process user (dev mode)
    return os.userInfo().username;
  } catch {
    // If config load fails or userInfo throws, return undefined
    return undefined;
  }
}

/**
 * Get daemon user, throwing if RBAC is enabled but user not configured
 *
 * Use this when initializing services that require Unix isolation.
 * For most operations, prefer getDaemonUser() which returns undefined on failure.
 *
 * @param config - Agor configuration (pass pre-loaded config to avoid re-loading)
 * @returns Unix username for the daemon
 * @throws Error if Unix isolation is enabled but daemon.unix_user is not configured
 */
export function requireDaemonUser(config: AgorConfig): string {
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

/**
 * Check if worktree RBAC is enabled
 *
 * When RBAC is enabled, git operations need to run via sudo to get fresh group memberships.
 *
 * @returns true if worktree_rbac is enabled in config
 */
export function isWorktreeRbacEnabled(): boolean {
  try {
    const config = loadConfigSync();
    return config.execution?.worktree_rbac === true;
  } catch {
    return false;
  }
}

/**
 * Check if Unix user impersonation is enabled
 *
 * Returns true when unix_user_mode is set to anything other than 'simple'
 * (i.e., 'insulated' or 'strict')
 */
export function isUnixImpersonationEnabled(): boolean {
  try {
    const config = loadConfigSync();
    const mode = config.execution?.unix_user_mode;
    return mode !== undefined && mode !== 'simple';
  } catch {
    return false;
  }
}

// =============================================================================
// Data Home Path Resolution
// =============================================================================
//
// AGOR_HOME vs AGOR_DATA_HOME:
//
// AGOR_HOME (~/.agor by default):
//   - Daemon operating files: config.yaml, agor.db, logs/
//   - Fast local storage (SSD)
//
// AGOR_DATA_HOME (defaults to AGOR_HOME):
//   - Git data: repos/, worktrees/
//   - Can be shared storage (EFS) for k8s deployments
//
// Priority (highest to lowest):
//   1. AGOR_DATA_HOME environment variable
//   2. paths.data_home in config.yaml
//   3. AGOR_HOME (backward compatible default)
//
// @see context/explorations/executor-expansion.md
// =============================================================================

/**
 * Get Agor data home directory
 *
 * This is where git repos and worktrees are stored.
 * Defaults to AGOR_HOME for backward compatibility.
 *
 * Resolution order:
 * 1. AGOR_DATA_HOME environment variable (highest priority)
 * 2. paths.data_home from config.yaml
 * 3. AGOR_HOME (same as getAgorHome(), backward compatible)
 *
 * @returns Absolute path to data home directory
 *
 * @example
 * ```ts
 * // Default (no config): ~/.agor
 * // With AGOR_DATA_HOME=/data/agor: /data/agor
 * // With paths.data_home: /mnt/efs/agor
 * const dataHome = getDataHome();
 * ```
 */
export function getDataHome(): string {
  // 1. Environment variable takes highest priority
  if (process.env.AGOR_DATA_HOME) {
    return expandHomePath(process.env.AGOR_DATA_HOME);
  }

  // 2. Check config file
  try {
    const config = loadConfigSync();
    if (config.paths?.data_home) {
      return expandHomePath(config.paths.data_home);
    }
  } catch {
    // Config load failed, fall through to default
  }

  // 3. Default to AGOR_HOME (backward compatible)
  return getAgorHome();
}

/**
 * Get repos directory path
 *
 * Returns: $AGOR_DATA_HOME/repos
 *
 * @returns Absolute path to repos directory
 */
export function getReposDir(): string {
  return path.join(getDataHome(), 'repos');
}

/**
 * Get worktrees directory path
 *
 * Returns: $AGOR_DATA_HOME/worktrees
 *
 * @returns Absolute path to worktrees directory
 */
export function getWorktreesDir(): string {
  return path.join(getDataHome(), 'worktrees');
}

/**
 * Get path for a specific worktree
 *
 * Returns: $AGOR_DATA_HOME/worktrees/<repoSlug>/<worktreeName>
 *
 * @param repoSlug - Repository slug (e.g., "preset-io/agor")
 * @param worktreeName - Worktree name (e.g., "feature-x")
 * @returns Absolute path to the worktree
 */
export function getWorktreePath(repoSlug: string, worktreeName: string): string {
  return path.join(getWorktreesDir(), repoSlug, worktreeName);
}

/**
 * Get data home directory (async version)
 *
 * Same as getDataHome() but loads config asynchronously.
 * Prefer this in async contexts to avoid blocking.
 *
 * @returns Absolute path to data home directory
 */
export async function getDataHomeAsync(): Promise<string> {
  // 1. Environment variable takes highest priority
  if (process.env.AGOR_DATA_HOME) {
    return expandHomePath(process.env.AGOR_DATA_HOME);
  }

  // 2. Check config file
  try {
    const config = await loadConfig();
    if (config.paths?.data_home) {
      return expandHomePath(config.paths.data_home);
    }
  } catch {
    // Config load failed, fall through to default
  }

  // 3. Default to AGOR_HOME (backward compatible)
  return getAgorHome();
}

/**
 * Get repos directory path (async version)
 *
 * @returns Absolute path to repos directory
 */
export async function getReposDirAsync(): Promise<string> {
  return path.join(await getDataHomeAsync(), 'repos');
}

/**
 * Get worktrees directory path (async version)
 *
 * @returns Absolute path to worktrees directory
 */
export async function getWorktreesDirAsync(): Promise<string> {
  return path.join(await getDataHomeAsync(), 'worktrees');
}
