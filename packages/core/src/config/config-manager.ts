/**
 * Agor Config Manager
 *
 * Handles loading and saving YAML configuration file.
 */

import { readFileSync, statSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import { getDefaultAnalyticsConfig } from './analytics-defaults.js';
import { DAEMON, MCP_TOKEN } from './constants';
import { resolveExecutorHeartbeatConfig } from './executor-heartbeat';
import { assertValidMultiTenancyConfig } from './multitenancy';
import {
  type AgorConfig,
  BRANCH_STORAGE_MODES,
  type BranchStorageMode,
  DEFAULT_BRANCH_STORAGE_MODE,
  type ResolvedBranchStorageConfig,
  type UnknownJson,
} from './types';

// ---------------------------------------------------------------------------
// In-memory cache for the default-path config
//
// The daemon's hot paths call loadConfig()/loadConfigSync() per-request — 10+
// times in services/branches.ts, services/artifacts.ts, services/terminals.ts,
// register-routes.ts, etc. Each call re-reads the YAML from disk and parses
// it. That's wasted work for a file that rarely changes.
//
// Strategy: stat-validated cache. On every call, stat() the file (a few
// microseconds on Linux) and compare (mtimeMs, size). Cache hit → return a
// fresh deep clone of the parsed config. Cache miss → read + parse + cache.
//
// Why a clone and not the cached object itself?
// Callers mutate the loaded config (`setConfigValue`, `unsetConfigValue`,
// `ConfigService.patch`) and then call `saveConfig()`. If we returned the
// shared cache object, a failed save would leave unsaved mutations visible
// to every subsequent reader. Returning a clone makes the cache effectively
// immutable from the outside.
//
// Why size in addition to mtimeMs?
// Some filesystems have coarse mtime resolution, and rapid same-tick rewrites
// can land on the same mtime. Combining mtimeMs with size catches the common
// "same instant, different bytes" case cheaply. It's not a cryptographic
// guarantee — a write that preserves size and mtime can still slip through —
// but in practice the pair is more than enough.
//
// Why not fs.watch? Surprising behavior on atomic renames (which is what
// saveConfig() effectively is), platform quirks, and stat is already free.
//
// Custom-path loads via loadConfigFromFile() are NOT cached — they're a
// startup-only path and adding a Map<path, entry> isn't worth the complexity.
// ---------------------------------------------------------------------------

interface CacheKey {
  /** mtimeMs from stat, or `NO_FILE` sentinel when the file doesn't exist. */
  mtimeMs: number;
  /** size in bytes, 0 when the file doesn't exist. */
  size: number;
}

interface ConfigCacheEntry {
  path: string;
  config: AgorConfig;
  key: CacheKey;
}

/** Sentinel: file didn't exist at cache time; default config is cached. */
const NO_FILE: number = -1;
const NO_FILE_KEY: CacheKey = { mtimeMs: NO_FILE, size: 0 };

let cachedEntry: ConfigCacheEntry | null = null;

function cacheKeyMatches(a: CacheKey, b: CacheKey): boolean {
  return a.mtimeMs === b.mtimeMs && a.size === b.size;
}

function statCacheKey(configPath: string): CacheKey | null {
  try {
    const stat = statSync(configPath);
    return { mtimeMs: stat.mtimeMs, size: stat.size };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return NO_FILE_KEY;
    }
    // Stat failed for some non-ENOENT reason — caller should not trust cache.
    return null;
  }
}

/**
 * Return a deep clone of the cached config if (path, mtime, size) still match
 * the file on disk. Returns null on any kind of mismatch — caller should
 * re-read.
 *
 * The clone is what makes the cache safe to expose: callers mutate the result
 * before `saveConfig()` and we don't want those mutations bleeding into the
 * next reader if the save fails.
 */
function readCachedConfig(configPath: string): AgorConfig | null {
  if (cachedEntry === null || cachedEntry.path !== configPath) {
    return null;
  }
  const currentKey = statCacheKey(configPath);
  if (currentKey === null || !cacheKeyMatches(currentKey, cachedEntry.key)) {
    return null;
  }
  return structuredClone(cachedEntry.config);
}

function writeCachedConfig(configPath: string, config: AgorConfig, key: CacheKey): void {
  // Clone on write too so a caller mutating their own copy can't reach back
  // through object identity and corrupt the cached value.
  cachedEntry = { path: configPath, config: structuredClone(config), key };
}

/**
 * Invalidate the in-memory config cache. Called from saveConfig() so that
 * the daemon's next read sees the fresh value.
 */
function invalidateConfigCache(): void {
  cachedEntry = null;
}

/**
 * Test-only: reset the in-memory config cache. Prefer this over poking at
 * module state directly. Production code should not need to call this.
 */
export function __resetConfigCacheForTests(): void {
  invalidateConfigCache();
}

/**
 * Parse + validate raw YAML config content. Shared by every load path so
 * `loadConfig()`, `loadConfigSync()`, and `loadConfigFromFile()` all reject
 * the same invalid inputs (e.g. deprecated `unix_user_mode: opportunistic`).
 */
function parseAndValidateConfig(content: string): AgorConfig {
  const parsed = yaml.load(content) as AgorConfig | undefined | null;
  const finalConfig = parsed || {};
  validateConfig(finalConfig);
  return finalConfig;
}

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

  const managedEnvExecutionMode = config.execution?.managed_envs_execution_mode;
  if (
    managedEnvExecutionMode !== undefined &&
    managedEnvExecutionMode !== 'hybrid' &&
    managedEnvExecutionMode !== 'webhook-only'
  ) {
    throw new Error(
      `Config error: execution.managed_envs_execution_mode must be one of: hybrid, webhook-only`
    );
  }

  assertValidMultiTenancyConfig(config);

  validateOptionalHttpUrl(
    config.external_launch as Record<string, unknown> | undefined,
    'login_redirect_url',
    'external_launch.login_redirect_url'
  );
}

function validateOptionalHttpUrl(
  container: Record<string, unknown> | undefined,
  key: string,
  configPath: string
): void {
  if (!container || container[key] === undefined) return;

  const raw = container[key];
  if (typeof raw !== 'string') {
    throw new Error(`Config error: ${configPath} must be an HTTP(S) URL string`);
  }

  container[key] = validateHttpUrlString(raw, configPath);
}

function validateHttpUrlString(
  url: string,
  label: string,
  options: { stripTrailingSlash?: boolean } = {}
): string {
  const trimmed = options.stripTrailingSlash ? url.trim().replace(/\/$/, '') : url.trim();

  if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) {
    throw new Error(`Invalid ${label}: "${url}". Must start with http:// or https://`);
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`Invalid ${label} format: "${url}". Must be a valid HTTP(S) URL.`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Invalid ${label}: "${url}". Must use http:// or https://`);
  }

  return trimmed;
}

/**
 * Load config from ~/.agor/config.yaml
 *
 * Returns default config if file doesn't exist.
 *
 * Stat-validated cache: subsequent calls with an unchanged file return a
 * fresh clone of the parsed result without re-reading or re-parsing YAML.
 * Callers can mutate the result freely without affecting other readers.
 */
export async function loadConfig(): Promise<AgorConfig> {
  const configPath = getConfigPath();

  const cached = readCachedConfig(configPath);
  if (cached !== null) {
    return cached;
  }

  // Stat-read-stat: if the file changes mid-read, the two stats won't match
  // and we skip caching this read entirely (returning the freshly parsed
  // value but leaving the cache empty so the next call re-reads).
  let beforeKey: CacheKey | null;
  let content: string;
  let afterKey: CacheKey | null;
  try {
    beforeKey = statCacheKey(configPath);
    if (beforeKey?.mtimeMs === NO_FILE) {
      const defaults = getDefaultConfig();
      writeCachedConfig(configPath, defaults, NO_FILE_KEY);
      return defaults;
    }
    content = await fs.readFile(configPath, 'utf-8');
    afterKey = statCacheKey(configPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      const defaults = getDefaultConfig();
      writeCachedConfig(configPath, defaults, NO_FILE_KEY);
      return defaults;
    }
    throw new Error(
      `Failed to load config: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  let finalConfig: AgorConfig;
  try {
    finalConfig = parseAndValidateConfig(content);
  } catch (error) {
    throw new Error(
      `Failed to load config: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (beforeKey !== null && afterKey !== null && cacheKeyMatches(beforeKey, afterKey)) {
    writeCachedConfig(configPath, finalConfig, beforeKey);
  }
  return finalConfig;
}

/**
 * Load config from a specific file path.
 *
 * Unlike loadConfig(), this does NOT fall back to defaults if the file is missing.
 * Throws on missing file or parse error.
 */
export async function loadConfigFromFile(filePath: string): Promise<AgorConfig> {
  const content = await fs.readFile(filePath, 'utf-8');
  return parseAndValidateConfig(content);
}

/**
 * Save config to ~/.agor/config.yaml
 *
 * Invalidates the in-memory cache so the next load reflects the fresh value.
 */
export async function saveConfig(config: AgorConfig): Promise<void> {
  validateConfig(config);
  await ensureAgorHome();

  const configPath = getConfigPath();
  const content = yaml.dump(config, {
    indent: 2,
    lineWidth: 120,
    noRefs: true,
  });

  await fs.writeFile(configPath, content, 'utf-8');
  invalidateConfigCache();
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
    },
    daemon: {
      port: DAEMON.DEFAULT_PORT,
      host: DAEMON.DEFAULT_HOST,
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
      executor_heartbeat: resolveExecutorHeartbeatConfig(),
    },
    analytics: getDefaultAnalyticsConfig(),
    telemetry: {},
    multi_tenancy: {
      mode: 'static',
      static_tenant_id: 'default',
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
    analytics: { ...defaults.analytics, ...config.analytics },
    telemetry: { ...defaults.telemetry, ...config.telemetry },
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
  return validateHttpUrlString(url, 'base URL', { stripTrailingSlash: true });
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

  // 3. Backward-compatible UI public URL used by older configs.
  if (config.ui?.base_url) {
    return validateBaseUrl(config.ui.base_url);
  }

  // 4. Default: construct from daemon port (no validation needed for default)
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

  if (config.ui?.base_url) {
    return validateBaseUrl(config.ui.base_url);
  }

  throw new PublicBaseUrlNotConfiguredError(
    'No public base URL configured. Set the AGOR_BASE_URL environment variable ' +
      'or `daemon.base_url` (preferred) / `ui.base_url` (legacy) in ~/.agor/config.yaml ' +
      "to the daemon's " +
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
 *
 * Shares the same stat-validated cache and the same parse+validate code as
 * {@link loadConfig}, so the sync entry point cannot poison the cache with
 * an invalid config that a later async caller would silently return.
 */
export function loadConfigSync(): AgorConfig {
  const configPath = getConfigPath();

  const cached = readCachedConfig(configPath);
  if (cached !== null) {
    return cached;
  }

  let beforeKey: CacheKey | null;
  let content: string;
  let afterKey: CacheKey | null;
  try {
    beforeKey = statCacheKey(configPath);
    if (beforeKey?.mtimeMs === NO_FILE) {
      const defaults = getDefaultConfig();
      writeCachedConfig(configPath, defaults, NO_FILE_KEY);
      return defaults;
    }
    content = readFileSync(configPath, 'utf-8');
    afterKey = statCacheKey(configPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      const defaults = getDefaultConfig();
      writeCachedConfig(configPath, defaults, NO_FILE_KEY);
      return defaults;
    }
    throw new Error(
      `Failed to load config: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  let finalConfig: AgorConfig;
  try {
    finalConfig = parseAndValidateConfig(content);
  } catch (error) {
    throw new Error(
      `Failed to load config: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (beforeKey !== null && afterKey !== null && cacheKeyMatches(beforeKey, afterKey)) {
    writeCachedConfig(configPath, finalConfig, beforeKey);
  }
  return finalConfig;
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
  | 'GEMINI_API_KEY'
  | 'CURSOR_API_KEY';

const CONFIG_CREDENTIAL_KEYS: ReadonlySet<string> = new Set<ConfigCredentialKey>([
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'CURSOR_API_KEY',
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
 * if (daemonUser && isUnixGroupRefreshNeeded()) {
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

  // 2. Check if Unix impersonation/isolation is enabled - if so, require explicit config.
  // Branch RBAC alone is logical app-level authorization and does not require
  // Unix users/groups in Cloud simple mode.
  const unixIsolationEnabled = resolveExecutionSecurityMode(config).requiresDaemonUnixUser;

  if (unixIsolationEnabled) {
    throw new Error(
      'Unix isolation is enabled (execution.unix_user_mode is insulated or strict) but daemon.unix_user is not configured.\n' +
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

export interface ResolvedExecutionSecurityMode {
  /** App-layer branch ownership/visibility/action enforcement. */
  appRbacEnabled: boolean;
  /** Configured Unix execution mode with default applied. */
  unixUserMode: import('./types').UnixUserMode;
  /** Whether executors/terminals may run as non-daemon OS users. */
  unixImpersonationEnabled: boolean;
  /** Whether branch filesystem permissions/groups should be materialized. */
  unixFsIsolationEnabled: boolean;
  /** Whether git/executor spawns need fresh supplemental Unix groups. */
  unixGroupRefreshNeeded: boolean;
  /** Whether daemon.unix_user must be explicitly configured. */
  requiresDaemonUnixUser: boolean;
  /** Whether new repos/branches should initialize Unix groups. */
  shouldInitUnixGroups: boolean;
}

/**
 * Resolve the execution security posture from config.
 *
 * Keep this as the single semantic boundary between app-layer RBAC and
 * OS/filesystem isolation:
 * - `branch_rbac` controls Agor app permissions only.
 * - non-`simple` `unix_user_mode` controls Unix impersonation/groups/FS ACLs.
 */
export function resolveExecutionSecurityMode(
  config: AgorConfig = loadConfigSync()
): ResolvedExecutionSecurityMode {
  const unixUserMode = config.execution?.unix_user_mode ?? 'simple';
  const unixIsolationEnabled = unixUserMode !== 'simple';

  return {
    appRbacEnabled: config.execution?.branch_rbac === true,
    unixUserMode,
    unixImpersonationEnabled: unixIsolationEnabled,
    unixFsIsolationEnabled: unixIsolationEnabled,
    unixGroupRefreshNeeded: unixIsolationEnabled,
    requiresDaemonUnixUser: unixIsolationEnabled,
    shouldInitUnixGroups: unixIsolationEnabled,
  };
}

/**
 * Check if logical branch RBAC is enabled.
 *
 * This controls app-level branch ownership/visibility. It does not necessarily
 * imply Unix group/ACL setup; Cloud simple mode may enable branch RBAC while
 * running all filesystem work as the daemon user.
 *
 * @returns true if branch_rbac is enabled in config
 */
export function isBranchRbacEnabled(): boolean {
  try {
    return resolveExecutionSecurityMode().appRbacEnabled;
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
    return resolveExecutionSecurityMode().unixImpersonationEnabled;
  } catch {
    return false;
  }
}

/**
 * Resolve `execution.branch_storage` with defaults applied.
 *
 * Default posture (v0.20+): both storage modes are enabled out of the box so
 * users can pick worktree or clone per branch from the create form / MCP
 * tool. `default_mode` stays on `'worktree'` for backwards compatibility —
 * existing automations that create branches without specifying a mode keep
 * landing on the legacy `git worktree add` path. Operators who want to
 * disable clone-mode entirely (e.g. for security gradient reasons) can pin
 * `allowed_modes: ['worktree']` in `~/.agor/config.yaml`.
 *
 * `default_mode` always falls back into `allowed_modes` if the operator
 * configured an inconsistent shape (e.g. set `default_mode: clone` but
 * forgot to add `clone` to `allowed_modes`) — load-time normalisation
 * keeps service code from needing to defensively re-validate.
 */
export function resolveBranchStorageConfig(): ResolvedBranchStorageConfig {
  let raw: import('./types').AgorBranchStorageSettings | undefined;
  try {
    raw = loadConfigSync().execution?.branch_storage;
  } catch {
    // Config unloadable (no file, parse error, etc.) — fall through to
    // the safe legacy default.
    raw = undefined;
  }
  const allowed: BranchStorageMode[] =
    raw?.allowed_modes && raw.allowed_modes.length > 0
      ? raw.allowed_modes
      : [...BRANCH_STORAGE_MODES];
  const requestedDefault = raw?.default_mode ?? DEFAULT_BRANCH_STORAGE_MODE;
  // Normalise: if the operator's default_mode isn't in allowed_modes, fall
  // back to the first allowed mode so we never hand out a default that the
  // gate would immediately reject.
  const defaultMode = allowed.includes(requestedDefault) ? requestedDefault : allowed[0];
  return { defaultMode, allowedModes: allowed };
}

/**
 * Throw a clear error if `mode` isn't in the operator-allowed set.
 * Centralised so the same wording appears across the daemon service, the
 * REST route, and the MCP tool.
 */
export function ensureBranchStorageModeAllowed(mode: import('./types').BranchStorageMode): void {
  const { allowedModes } = resolveBranchStorageConfig();
  if (!allowedModes.includes(mode)) {
    throw new Error(
      `storage_mode='${mode}' is not enabled on this Agor instance. ` +
        `Enable it by adding '${mode}' to execution.branch_storage.allowed_modes ` +
        `in ~/.agor/config.yaml. Currently allowed: ${allowedModes.map((m) => `'${m}'`).join(', ')}.`
    );
  }
}

/**
 * Whether the daemon needs to wrap git operations in `sudo -u` to pick up
 * supplemental Unix groups created after daemon startup.
 *
 * Cloud simple mode can enable logical `branch_rbac` without Unix groups. Only
 * non-simple Unix modes require group refresh / sudo wrapping.
 *
 * Returns true when `unix_user_mode` is `insulated` or `strict`.
 */
export function isUnixGroupRefreshNeeded(): boolean {
  return resolveExecutionSecurityMode().unixGroupRefreshNeeded;
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
//   - Git data: repos/, branches/
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
 * This is where git repos and branches are stored.
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
 * Get the on-disk root for branch directories.
 *
 * Returns: $AGOR_DATA_HOME/worktrees
 *
 * The on-disk dir name is `worktrees/` even though the conceptual entity
 * is now Branch — the v0.20 rename deliberately kept the dir name to
 * avoid a filesystem migration on existing installs (renaming would
 * orphan every branch.path row + every per-user symlink). The helper
 * name reflects the conceptual entity; the value is a compat artifact.
 *
 * @returns Absolute path to the branches directory
 */
export function getBranchesDir(): string {
  return path.join(getDataHome(), 'worktrees');
}

/**
 * Get path for a specific branch on disk.
 *
 * Returns: $AGOR_DATA_HOME/worktrees/<repoSlug>/<branchName>
 *
 * See {@link getBranchesDir} for why the on-disk dir is still `worktrees/`.
 *
 * @param repoSlug - Repository slug (e.g., "preset-io/agor")
 * @param branchName - Branch name (e.g., "feature-x")
 * @returns Absolute path to the branch
 */
export function getBranchPath(repoSlug: string, branchName: string): string {
  return path.join(getBranchesDir(), repoSlug, branchName);
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
 * Get branches directory path (async version).
 *
 * Same on-disk-dir compat as {@link getBranchesDir} — value is
 * `worktrees/`, helper name is Branch-conceptual.
 *
 * @returns Absolute path to branches directory
 */
export async function getBranchesDirAsync(): Promise<string> {
  return path.join(await getDataHomeAsync(), 'worktrees');
}
