/**
 * Agor Config Manager
 *
 * Handles loading and saving YAML configuration file.
 */

import { randomUUID } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as yaml from 'js-yaml';
import { type InstallableAgenticTool, isInstallableAgenticTool } from '../agentic-integrations';
import { EXECUTOR_RESPONSE_PROTOCOL } from '../executor-protocol';
import type { AgenticToolName } from '../types';
import { normalizeHttpBaseUrl } from '../utils/url';
import { ensureAgorHome, ensureAgorHomeSync, getAgorHome, getConfigPath } from './agor-home';
import { getDefaultAnalyticsConfig } from './analytics-defaults.js';
import { DAEMON, MCP_TOKEN } from './constants';
import { validateRedisKeyPrefix, validateRedisUrl } from './deployment';
import {
  resolveDispatchConnectTimeoutMs,
  resolveExecutorHeartbeatConfig,
  resolveSdkWatchdogConfig,
} from './executor-heartbeat';
import { resolveExecutorResponseConfig } from './executor-response';
import {
  assertValidRawExternalLaunchConfig,
  resolveEffectiveExternalLaunchConfig,
} from './external-launch';
import { assertValidMultiTenancyConfig } from './multitenancy';
import { AgorPasswordPolicyProfile } from './password-policy';
import { isPlainConfigRecord } from './plain-record';
import {
  type AgorApmSettings,
  type AgorConfig,
  AgorExternalIdentityProvider,
  AgorExternalIdentityProvisioning,
  AgorLocalAuthMode,
  AgorRoleAuthority,
  type AgorStatsDSettings,
  AgorUserLifecycleAuthority,
  APM_TRACE_SERVICE_DEPTHS,
  BRANCH_STORAGE_MODES,
  type BranchStorageMode,
  DEFAULT_BRANCH_STORAGE_MODE,
  type ResolvedBranchStorageConfig,
  type UnixUserMode,
  type UnknownJson,
} from './types';

export const RETIRED_CONFIG_KEYS = {
  daemon: ['allowAnonymous', 'requireAuth'],
  defaults: ['board', 'agent'],
  display: ['tableStyle', 'colorOutput', 'shortIdLength'],
  execution: ['managed_envs_minimum_role'],
  branches: ['others_can_default', 'others_fs_access_default'],
  onboarding: ['teammatePending', 'assistantPending', 'persistedAgentPending'],
  mcp_catalog: ['registry_sync_enabled', 'sync_interval_hours', 'probe_budget', 'registry_url'],
} as const;

export const RETIRED_CONFIG_PATHS = new Set<string>(
  Object.entries(RETIRED_CONFIG_KEYS).flatMap(([section, keys]) =>
    keys.map((key) => `${section}.${key}`)
  )
);

type LegacyConfig = AgorConfig & {
  daemon?: AgorConfig['daemon'] & Record<string, unknown>;
  defaults?: Record<string, unknown>;
  display?: Record<string, unknown>;
  execution?: AgorConfig['execution'] & Record<string, unknown>;
  branches?: Record<string, unknown>;
  onboarding?: Record<string, unknown>;
  mcp_catalog?: Record<string, unknown>;
};

/** Resolve the renamed operator setting while keeping old YAML loadable. */
export function resolveTeammateFrameworkRepoUrl(config: AgorConfig): string | undefined {
  const legacyUrl = (config as LegacyConfig).onboarding?.frameworkRepoUrl;
  return (
    config.teammates?.framework_repo_url ?? (typeof legacyUrl === 'string' ? legacyUrl : undefined)
  );
}

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
// Returning a clone makes the cached deployment input effectively immutable
// from callers, including the explicitly guarded CLI rewrite path.
//
// Why size in addition to mtimeMs?
// Some filesystems have coarse mtime resolution, and rapid same-tick rewrites
// can land on the same mtime. Combining mtimeMs with size catches the common
// "same instant, different bytes" case cheaply. It's not a cryptographic
// guarantee — a write that preserves size and mtime can still slip through —
// but in practice the pair is more than enough.
//
// Why not fs.watch? Atomic replacement and platform quirks are surprising,
// while stat is already cheap.
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

/**
 * Wrap a config read/stat failure, explaining the sandbox when we're inside it.
 *
 * The executor sandbox masks the daemon config with a `/dev/null` bind mount,
 * so reads from inside fail with EACCES rather than ENOENT. That is the mask
 * working as designed. Code running in the sandbox is contractually forbidden
 * from reading the daemon config (see `packages/executor/src/contract.test.ts`)
 * and receives what it needs via `payload.resolvedConfig` and `DAEMON_URL`.
 *
 * Deliberately an error and not a fall back to `getDefaultConfig()`: the
 * defaults carry no `paths` key and disable filesystem isolation, so
 * fabricating them would silently resolve tenant data roots to the wrong
 * directory instead of failing. A wrong answer here crosses a tenant boundary;
 * a loud one does not.
 */
function configLoadError(configPath: string, error: unknown): Error {
  const detail = error instanceof Error ? error.message : String(error);
  if (process.env.AGOR_OUTER_SANDBOX === '1') {
    return new Error(
      `${configPath} is masked by Agor's executor sandbox and is intentionally out of reach. ` +
        'Code inside the sandbox must not read the daemon config — it receives configuration ' +
        'via payload.resolvedConfig and DAEMON_URL. Run this on the daemon host instead. ' +
        `See context/explorations/executor-sandboxing.md. (underlying error: ${detail})`
    );
  }
  return new Error(`Failed to load config: ${detail}`);
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
 * before an explicit rewrite and we don't want mutations bleeding into the
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
 * Invalidate the cache after init creation or an explicit destructive rewrite.
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
  if (content.trim() === '') {
    return {};
  }

  const parsed = yaml.load(content) as AgorConfig | undefined | null;
  const finalConfig = parsed || {};
  validateConfig(finalConfig);
  return finalConfig;
}

/** Shared state-home paths and creation policy. */
export { ensureAgorHome, ensureAgorHomeSync, getAgorHome, getConfigPath };

/**
 * Validate config and throw helpful errors for deprecated/invalid settings
 */
function assertSupportedUnixUserMode(mode: unknown): asserts mode is UnixUserMode | undefined {
  if (mode === undefined || mode === 'simple' || mode === 'sandbox' || mode === 'delegated') return;
  if (mode === 'opportunistic' || mode === 'strict' || mode === 'insulated') {
    throw new Error(
      `Config error: execution.unix_user_mode '${String(mode)}' was removed in Agor 0.25.0.\n` +
        `Migrate with the latest Agor 0.24.x release, then choose one of:\n` +
        `  - 'sandbox': fail-closed local Linux filesystem isolation (recommended)\n` +
        `  - 'simple': trusted local execution without Agor filesystem isolation\n` +
        `  - 'delegated': identity and isolation supplied by an external execution substrate`
    );
  }
  throw new Error(
    `Config error: execution.unix_user_mode must be one of: simple, sandbox, delegated (received ${JSON.stringify(mode)})`
  );
}

const FORBIDDEN_OPERATIONAL_METRIC_TAG_KEY =
  /(^|[_.-])(tenant|user|session|task|branch|repo|repository|email|uuid|token|secret|prompt|path|url|title|slug|name|id|host|hostname|pod|container|boot)($|[_.-])/i;
const RESERVED_OPERATIONAL_METRIC_TAG_KEYS = new Set([
  'daemon_instance',
  'deployment_id',
  'deployment_mode',
]);

function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
}

function validateStatsDConfig(statsd: AgorStatsDSettings | undefined): void {
  if (statsd === undefined) return;
  if (!statsd || typeof statsd !== 'object' || Array.isArray(statsd)) {
    throw new Error('Config error: metrics.statsd must be an object');
  }
  if (statsd.enabled !== undefined && typeof statsd.enabled !== 'boolean') {
    throw new Error('Config error: metrics.statsd.enabled must be a boolean');
  }
  if (
    statsd.host !== undefined &&
    (typeof statsd.host !== 'string' ||
      statsd.host.trim() === '' ||
      statsd.host.length > 253 ||
      /[\s/\\]/.test(statsd.host) ||
      statsd.host.includes('://'))
  ) {
    throw new Error(
      'Config error: metrics.statsd.host must be a non-empty hostname or IP address without a URL scheme'
    );
  }
  if (
    statsd.port !== undefined &&
    (!Number.isSafeInteger(statsd.port) || statsd.port < 1 || statsd.port > 65_535)
  ) {
    throw new Error('Config error: metrics.statsd.port must be an integer from 1 to 65535');
  }
  if (
    statsd.prefix !== undefined &&
    (typeof statsd.prefix !== 'string' ||
      statsd.prefix.length > 64 ||
      !/^[a-zA-Z][a-zA-Z0-9_.-]*\.$/.test(statsd.prefix))
  ) {
    throw new Error(
      'Config error: metrics.statsd.prefix must start with a letter, contain only letters, digits, dots, underscores, or hyphens, and end with a dot'
    );
  }
  if (statsd.global_tags === undefined) return;
  if (
    !statsd.global_tags ||
    typeof statsd.global_tags !== 'object' ||
    Array.isArray(statsd.global_tags)
  ) {
    throw new Error('Config error: metrics.statsd.global_tags must be a string map');
  }
  const entries = Object.entries(statsd.global_tags as Record<string, unknown>);
  if (entries.length > 20) {
    throw new Error('Config error: metrics.statsd.global_tags supports at most 20 tags');
  }
  for (const [key, value] of entries) {
    if (!/^[a-zA-Z][a-zA-Z0-9_.-]{0,62}$/.test(key)) {
      throw new Error(`Config error: metrics.statsd.global_tags key '${key}' is invalid`);
    }
    if (
      RESERVED_OPERATIONAL_METRIC_TAG_KEYS.has(key.toLowerCase()) ||
      FORBIDDEN_OPERATIONAL_METRIC_TAG_KEY.test(key)
    ) {
      throw new Error(
        `Config error: metrics.statsd.global_tags key '${key}' is reserved or violates the low-cardinality policy`
      );
    }
    if (
      typeof value !== 'string' ||
      value.trim() === '' ||
      value.length > 100 ||
      containsControlCharacter(value) ||
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    ) {
      throw new Error(
        `Config error: metrics.statsd.global_tags value for '${key}' must be a non-empty, low-cardinality string of at most 100 characters`
      );
    }
  }
}

function validateApmConfig(apm: AgorApmSettings | undefined): void {
  if (apm === undefined) return;
  if (!apm || typeof apm !== 'object' || Array.isArray(apm)) {
    throw new Error('Config error: metrics.apm must be an object');
  }
  if (apm.trace_services !== undefined && !APM_TRACE_SERVICE_DEPTHS.includes(apm.trace_services)) {
    throw new Error(
      `Config error: metrics.apm.trace_services must be one of: ${APM_TRACE_SERVICE_DEPTHS.join(', ')}`
    );
  }
}

function parseOptionalBooleanEnvironmentValue(
  value: string | undefined,
  name: string
): boolean | undefined {
  if (value === undefined || value === '') return undefined;
  if (value === '1' || value === 'true') return true;
  if (value === '0' || value === 'false') return false;
  throw new Error(`Config error: ${name} must be one of: true, false, 1, 0`);
}

function parseOptionalApmTraceDepthEnvironmentValue(
  value: string | undefined
): AgorApmSettings['trace_services'] | undefined {
  if (value === undefined || value === '') return undefined;
  if (!APM_TRACE_SERVICE_DEPTHS.includes(value as never)) {
    throw new Error(
      `Config error: AGOR_APM_TRACE_SERVICES must be one of: ${APM_TRACE_SERVICE_DEPTHS.join(', ')}`
    );
  }
  return value as AgorApmSettings['trace_services'];
}

function parseOptionalPortEnvironmentValue(
  value: string | undefined,
  name: string
): number | undefined {
  if (value === undefined || value === '') return undefined;
  if (!/^\d+$/.test(value)) {
    throw new Error(`Config error: ${name} must be an integer from 1 to 65535`);
  }
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Config error: ${name} must be an integer from 1 to 65535`);
  }
  return port;
}

function parseOptionalSdkHomeModeEnvironmentValue(
  value: string | undefined
): 'inherit' | 'per_branch' | undefined {
  if (value === undefined || value === '') return undefined;
  if (value === 'inherit' || value === 'per_branch') return value;
  throw new Error('Config error: AGOR_SANDBOX_SDK_HOME_MODE must be one of: inherit, per_branch');
}

/**
 * Policy for config keys the daemon does not recognize.
 *
 * `error` (default) fails closed — the safe choice for humans editing config,
 * because a typo like `unix_user_mdoe` is caught instead of silently ignored.
 *
 * `warn` tolerates unknown keys (logs each and continues). This exists for
 * forward compatibility during rolling deploys and rollbacks: config written
 * for a newer daemon can be read by an older one that predates a purely
 * ADDITIVE key it can safely ignore (e.g. `execution.executor_response` — an
 * older daemon just uses its old path). It is NOT safe for a key that changes a
 * default or security posture the old binary must honor; those still require
 * deploy ordering. Env-only (not a config key) to avoid the chicken-and-egg of
 * a strictness switch that could itself be an unknown key, and because it is a
 * deploy/ops decision that should persist across image rollbacks.
 */
type UnknownConfigKeyPolicy = 'error' | 'warn';

function resolveUnknownConfigKeyPolicy(): UnknownConfigKeyPolicy {
  const raw = process.env.AGOR_UNKNOWN_CONFIG_KEYS?.trim().toLowerCase();
  if (raw === undefined || raw === '' || raw === 'error') return 'error';
  if (raw === 'warn') return 'warn';
  throw new Error(
    `Config error: AGOR_UNKNOWN_CONFIG_KEYS must be 'error' or 'warn' (got '${process.env.AGOR_UNKNOWN_CONFIG_KEYS}')`
  );
}

function requirePlainConfigRecord(value: unknown, path: string): void {
  if (!isPlainConfigRecord(value)) {
    throw new Error(`Config error: ${path} must be an object`);
  }
}

function validateConfig(config: AgorConfig): void {
  requirePlainConfigRecord(config, 'config');
  const configuredAnalyticsPlugins = (config.analytics as { plugins?: unknown[] } | undefined)
    ?.plugins;
  const removedModulePluginIndex = configuredAnalyticsPlugins?.findIndex(
    (plugin) =>
      !!plugin && typeof plugin === 'object' && (plugin as { type?: unknown }).type === 'module'
  );
  if (removedModulePluginIndex !== undefined && removedModulePluginIndex >= 0) {
    throw new Error(
      `Config error: analytics.plugins[${removedModulePluginIndex}].type 'module' has been removed because loading operator-selected code in the daemon is unsafe. Use the built-in 'stdout' or 'http_batch' analytics plugin instead.`
    );
  }
  const removedConfig = config as AgorConfig & {
    resources?: unknown;
    services?: unknown;
  };
  if (removedConfig.resources !== undefined) {
    throw new Error(
      "Config error: 'resources' has been removed. Create users, repositories, and branches through their typed APIs instead."
    );
  }
  if (removedConfig.services !== undefined) {
    throw new Error(
      "Config error: 'services' has been removed. Agor services are registered consistently for every tenant."
    );
  }
  const removedProviderConfig = config as AgorConfig & {
    credentials?: unknown;
    opencode?: unknown;
    codex?: unknown;
    knowledge?: unknown;
    execution?: AgorConfig['execution'] & { cursor_sdk_enabled?: unknown };
  };
  if (removedProviderConfig.credentials !== undefined) {
    throw new Error(
      "Config error: 'credentials' has been removed. Configure workspace agentic tools in Settings."
    );
  }
  if (removedProviderConfig.opencode !== undefined) {
    throw new Error(
      "Config error: 'opencode' has been removed. Configure OpenCode availability in workspace agentic-tool settings."
    );
  }
  // Stale since #1136 (per-session CODEX_HOME removal); flagged here so
  // upgrading installs get guidance instead of a generic unrecognized-key error.
  if (removedProviderConfig.codex !== undefined) {
    throw new Error(
      "Config error: 'codex' has been removed. Codex home directories are managed per-session automatically."
    );
  }
  if (removedProviderConfig.knowledge !== undefined) {
    throw new Error(
      "Config error: 'knowledge' has been removed. Configure semantic search in workspace Knowledge settings."
    );
  }
  if (removedProviderConfig.execution?.cursor_sdk_enabled !== undefined) {
    throw new Error(
      "Config error: 'execution.cursor_sdk_enabled' has been removed. Configure Cursor availability in workspace agentic-tool settings."
    );
  }
  const removedUnixExecution = config.execution as
    | (NonNullable<AgorConfig['execution']> & {
        executor_unix_user?: unknown;
        sync_unix_passwords?: unknown;
      })
    | undefined;
  const removedUnixKeys = ['executor_unix_user', 'sync_unix_passwords'].filter(
    (key) => removedUnixExecution?.[key as keyof typeof removedUnixExecution] !== undefined
  );
  if (removedUnixKeys.length > 0) {
    throw new Error(
      `Config error: removed host Unix execution ${removedUnixKeys.length === 1 ? 'key' : 'keys'}: ${removedUnixKeys.map((key) => `execution.${key}`).join(', ')}. ` +
        "Remove them and choose execution.unix_user_mode 'simple', 'sandbox', or 'delegated'."
    );
  }

  const knownTopLevelKeys = new Set([
    'agentic_tools',
    'defaults',
    'display',
    'daemon',
    'deployment',
    'ui',
    'database',
    'external_launch',
    'identity',
    'execution',
    'security',
    'branches',
    'teammates',
    'paths',
    'analytics',
    'telemetry',
    'metrics',
    'onboarding',
    'multi_tenancy',
    'uploads',
    'mcp_catalog',
  ]);
  const unknownTopLevelKeys = Object.keys(config).filter((key) => !knownTopLevelKeys.has(key));
  if (unknownTopLevelKeys.length > 0) {
    throw new Error(
      `Config error: unrecognized top-level key${unknownTopLevelKeys.length === 1 ? '' : 's'}: ${unknownTopLevelKeys.join(', ')}`
    );
  }

  const unknownPaths: string[] = [];
  const only = (value: unknown, path: string, allowed: readonly string[]) => {
    if (value === undefined) return;
    requirePlainConfigRecord(value, path);
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (!allowed.includes(key)) unknownPaths.push(`${path}.${key}`);
    }
  };
  const legacyConfig = config as LegacyConfig;
  only(config.agentic_tools, 'agentic_tools', ['installed', 'claude_subscription_oauth']);
  if (
    config.agentic_tools?.claude_subscription_oauth !== undefined &&
    typeof config.agentic_tools.claude_subscription_oauth !== 'boolean'
  ) {
    throw new Error('Config error: agentic_tools.claude_subscription_oauth must be a boolean');
  }
  if (config.agentic_tools?.installed !== undefined) {
    if (!Array.isArray(config.agentic_tools.installed)) {
      throw new Error("Config error: 'agentic_tools.installed' must be an array");
    }
    const unknown = config.agentic_tools.installed.filter(
      (tool) => typeof tool !== 'string' || !isInstallableAgenticTool(tool)
    );
    if (unknown.length > 0) {
      throw new Error(
        `Config error: 'agentic_tools.installed' contains unsupported tool(s): ${unknown.join(', ')}`
      );
    }
    const duplicates = config.agentic_tools.installed.filter(
      (tool, index, tools) => tools.indexOf(tool) !== index
    );
    if (duplicates.length > 0) {
      throw new Error(
        `Config error: 'agentic_tools.installed' contains duplicate tool(s): ${[...new Set(duplicates)].join(', ')}`
      );
    }
  }
  only(legacyConfig.defaults, 'defaults', RETIRED_CONFIG_KEYS.defaults);
  // Known upgrade-only keys remain loadable so the daemon can print its
  // dedicated deprecation guidance before ignoring them. `display` is not
  // part of AgorConfig anymore: all three settings were retired.
  only(legacyConfig.display, 'display', RETIRED_CONFIG_KEYS.display);
  only(config.deployment, 'deployment', ['mode', 'redis', 'ha']);
  only(config.deployment?.redis, 'deployment.redis', [
    'url',
    'key_prefix',
    'connect_timeout_ms',
    'startup_timeout_ms',
    'request_timeout_ms',
    'reconnect_base_delay_ms',
    'reconnect_max_delay_ms',
  ]);
  only(config.deployment?.ha, 'deployment.ha', [
    'support_profile',
    'execution_topology',
    'shared_filesystem',
    'ingress_affinity',
    'environment_health_monitor',
  ]);
  only(
    config.deployment?.ha?.environment_health_monitor,
    'deployment.ha.environment_health_monitor',
    [
      'scan_interval_ms',
      'max_idle_interval_ms',
      'startup_offset_max_ms',
      'scan_batch_size',
      'max_in_flight',
      'http_timeout_ms',
      'claim_lease_ms',
      'shutdown_drain_timeout_ms',
    ]
  );
  if (
    config.deployment?.mode !== undefined &&
    config.deployment.mode !== 'standalone' &&
    config.deployment.mode !== 'ha'
  ) {
    throw new Error('Config error: deployment.mode must be one of: standalone, ha');
  }
  if (
    config.deployment?.ha?.support_profile !== undefined &&
    config.deployment.ha.support_profile !== 'constrained-active-active'
  ) {
    throw new Error(
      'Config error: deployment.ha.support_profile must be constrained-active-active'
    );
  }
  if (
    config.deployment?.ha?.execution_topology !== undefined &&
    config.deployment.ha.execution_topology !== 'shared-local' &&
    config.deployment.ha.execution_topology !== 'external'
  ) {
    throw new Error(
      'Config error: deployment.ha.execution_topology must be shared-local or external'
    );
  }
  if (config.deployment?.redis?.url !== undefined) {
    validateRedisUrl(config.deployment.redis.url);
  }
  if (config.deployment?.redis?.key_prefix !== undefined) {
    validateRedisKeyPrefix(config.deployment.redis.key_prefix);
  }
  for (const key of [
    'connect_timeout_ms',
    'startup_timeout_ms',
    'request_timeout_ms',
    'reconnect_base_delay_ms',
    'reconnect_max_delay_ms',
  ] as const) {
    const value = config.deployment?.redis?.[key];
    if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
      throw new Error(`Config error: deployment.redis.${key} must be a positive integer`);
    }
  }
  for (const key of ['shared_filesystem', 'ingress_affinity'] as const) {
    const value = config.deployment?.ha?.[key];
    if (value !== undefined && typeof value !== 'boolean') {
      throw new Error(`Config error: deployment.ha.${key} must be a boolean`);
    }
  }
  only(config.daemon, 'daemon', [
    'deployment_id',
    'port',
    'host',
    'host_ip_address',
    'public_url',
    'base_url',
    'jwtSecret',
    'masterSecret',
    'mcpEnabled',
    'mcpToolSearch',
    'instanceLabel',
    'instanceDescription',
    'impersonation_token_expiry_ms',
    'cors_allow_sandpack',
    'cors_origins',
    'trust_proxy_hops',
    ...RETIRED_CONFIG_KEYS.daemon,
  ]);
  only(config.ui, 'ui', ['base_url', 'port', 'host']);
  only(config.uploads, 'uploads', ['location', 'max_age_days', 'max_file_size_mb']);
  only(config.external_launch, 'external_launch', [
    'enabled',
    'exchange_url',
    'issuer',
    'audience',
    'instance_id',
    'provider_id',
    'jwks_url',
    'public_key',
    'dev_shared_secret',
    'dev_shared_secret_env',
    'service_credential',
    'service_credential_env',
    'request_timeout_ms',
    'algorithms',
    'allow_admin_roles',
    'trust_verified_email_for_linking',
    'login_redirect_url',
    'forward_request_host',
    'trusted_host_header',
    'return_host_param',
  ]);
  assertValidRawExternalLaunchConfig(config.external_launch);
  only(config.identity, 'identity', [
    'user_lifecycle',
    'role_authority',
    'local_auth',
    'password_policy',
    'external',
  ]);
  only(config.identity?.external, 'identity.external', ['provider', 'provisioning']);
  if (
    config.identity?.user_lifecycle !== undefined &&
    !Object.values(AgorUserLifecycleAuthority).includes(config.identity.user_lifecycle)
  ) {
    throw new Error('Config error: identity.user_lifecycle must be internal or external');
  }
  if (
    config.identity?.role_authority !== undefined &&
    !Object.values(AgorRoleAuthority).includes(config.identity.role_authority)
  ) {
    throw new Error('Config error: identity.role_authority must be internal or claims');
  }
  if (
    config.identity?.local_auth !== undefined &&
    !Object.values(AgorLocalAuthMode).includes(config.identity.local_auth)
  ) {
    throw new Error('Config error: identity.local_auth must be enabled or disabled');
  }
  if (
    config.identity?.password_policy !== undefined &&
    config.identity.password_policy !== AgorPasswordPolicyProfile.SECURE
  ) {
    throw new Error("Config error: identity.password_policy must be 'secure'");
  }
  if (
    config.identity?.external?.provider !== undefined &&
    config.identity.external.provider !== AgorExternalIdentityProvider.EXTERNAL_LAUNCH
  ) {
    throw new Error('Config error: identity.external.provider must be external_launch');
  }
  if (
    config.identity?.external?.provisioning !== undefined &&
    config.identity.external.provisioning !== AgorExternalIdentityProvisioning.JIT
  ) {
    throw new Error('Config error: identity.external.provisioning must be jit');
  }
  if (config.uploads !== undefined) {
    if (
      typeof config.uploads.location !== 'undefined' &&
      (typeof config.uploads.location !== 'string' || config.uploads.location.trim() === '')
    ) {
      throw new Error("Config error: 'uploads.location' must be a non-empty path or s3:// URI");
    }
    if (
      typeof config.uploads.max_age_days !== 'undefined' &&
      (!Number.isSafeInteger(config.uploads.max_age_days) ||
        config.uploads.max_age_days < 0 ||
        !Number.isSafeInteger(config.uploads.max_age_days * 24 * 60 * 60 * 1000))
    ) {
      throw new Error("Config error: 'uploads.max_age_days' must be a non-negative integer");
    }
    if (
      typeof config.uploads.max_file_size_mb !== 'undefined' &&
      (!Number.isSafeInteger(config.uploads.max_file_size_mb) ||
        config.uploads.max_file_size_mb <= 0 ||
        !Number.isSafeInteger(config.uploads.max_file_size_mb * 1024 * 1024))
    ) {
      throw new Error("Config error: 'uploads.max_file_size_mb' must be a positive integer");
    }
  }
  only(config.database, 'database', ['dialect', 'sqlite', 'postgresql']);
  only(config.database?.sqlite, 'database.sqlite', ['path', 'walMode', 'busyTimeout']);
  only(config.database?.postgresql, 'database.postgresql', [
    'url',
    'host',
    'port',
    'database',
    'user',
    'password',
    'pool',
    'ssl',
    'schema',
  ]);
  only(config.database?.postgresql?.pool, 'database.postgresql.pool', [
    'min',
    'max',
    'idleTimeout',
  ]);
  if (typeof config.database?.postgresql?.ssl === 'object') {
    only(config.database.postgresql.ssl, 'database.postgresql.ssl', [
      'rejectUnauthorized',
      'ca',
      'cert',
      'key',
    ]);
  }
  only(config.execution, 'execution', [
    'executor_heartbeat',
    'executor_response',
    'sdk_watchdog',
    'dispatch_connect_timeout_ms',
    'unix_user_mode',
    'branch_rbac',
    'allow_web_terminal',
    'allow_superadmin',
    'bootstrap_superadmin_users',
    'session_token_expiration_ms',
    'session_token_max_uses',
    'mcp_token_expiration_ms',
    'daemon_writes_user_message',
    'permission_timeout_ms',
    'executor_command_template',
    'executor_storage',
    'executor_command_nonzero_may_have_dispatched',
    'required_user_env_vars',
    ...RETIRED_CONFIG_KEYS.execution,
    'managed_envs_execution_mode',
    'branch_storage',
    'sandbox',
  ]);
  only(config.execution?.executor_heartbeat, 'execution.executor_heartbeat', [
    'enabled',
    'interval_ms',
    'stale_after_ms',
    'callback',
  ]);
  only(config.execution?.executor_heartbeat?.callback, 'execution.executor_heartbeat.callback', [
    'command_template',
    'timeout_ms',
  ]);
  only(config.execution?.executor_response, 'execution.executor_response', [
    'max_response_bytes',
    'max_active_requests',
    'timeout_ms',
    'origin_url',
    'external_protocol',
  ]);
  only(config.execution?.executor_response?.timeout_ms, 'execution.executor_response.timeout_ms', [
    'default',
    'by_command',
  ]);
  resolveExecutorResponseConfig(config.execution?.executor_response);
  only(config.execution?.sdk_watchdog, 'execution.sdk_watchdog', [
    'mode',
    'first_progress_timeout_ms',
    'abort_grace_ms',
    'claude_idle_timeout_ms',
  ]);
  if (config.execution?.sdk_watchdog) {
    resolveSdkWatchdogConfig(config.execution);
  }
  resolveDispatchConnectTimeoutMs(config.execution);
  only(config.execution?.branch_storage, 'execution.branch_storage', [
    'default_mode',
    'allowed_modes',
    'allow_shallow_clones',
    'borrow_base_objects',
  ]);
  only(config.execution?.sandbox, 'execution.sandbox', [
    'enabled',
    'include',
    'protect_secrets',
    'isolate_branches',
    'home_mode',
    'sdk_home_mode',
    'preserve_canonical_home_alias',
    'extra_allow_write',
    'extra_deny_read',
    'fail_if_unavailable',
  ]);
  only(config.execution?.sandbox?.include, 'execution.sandbox.include', [
    'branch',
    'base_repo',
    'tmp',
    'home',
  ]);
  if (
    config.execution?.branch_rbac !== undefined &&
    typeof config.execution.branch_rbac !== 'boolean'
  ) {
    throw new Error('Config error: execution.branch_rbac must be a boolean');
  }
  if (
    config.execution?.sandbox?.preserve_canonical_home_alias !== undefined &&
    typeof config.execution.sandbox.preserve_canonical_home_alias !== 'boolean'
  ) {
    throw new Error(
      'Config error: execution.sandbox.preserve_canonical_home_alias must be a boolean'
    );
  }
  only(config.execution?.executor_storage, 'execution.executor_storage', [
    'user_home',
    'user_home_locking',
    'branch_workspace',
    'base_repository',
  ]);
  if (
    config.execution?.executor_storage?.user_home !== undefined &&
    !['replica-local', 'shared', 'persistent-per-user'].includes(
      config.execution.executor_storage.user_home
    )
  ) {
    throw new Error(
      'Config error: execution.executor_storage.user_home must be replica-local, shared, or persistent-per-user'
    );
  }
  if (
    config.execution?.executor_storage?.user_home_locking !== undefined &&
    !['local-only', 'cross-replica-flock'].includes(
      config.execution.executor_storage.user_home_locking
    )
  ) {
    throw new Error(
      'Config error: execution.executor_storage.user_home_locking must be local-only or cross-replica-flock'
    );
  }
  if (
    config.execution?.executor_storage?.branch_workspace !== undefined &&
    !['replica-local', 'shared', 'persistent-per-branch'].includes(
      config.execution.executor_storage.branch_workspace
    )
  ) {
    throw new Error(
      'Config error: execution.executor_storage.branch_workspace must be replica-local, shared, or persistent-per-branch'
    );
  }
  if (
    config.execution?.executor_storage?.base_repository !== undefined &&
    !['replica-local', 'shared', 'unavailable'].includes(
      config.execution.executor_storage.base_repository
    )
  ) {
    throw new Error(
      'Config error: execution.executor_storage.base_repository must be replica-local, shared, or unavailable'
    );
  }
  if (
    config.execution?.branch_storage?.allow_shallow_clones !== undefined &&
    typeof config.execution.branch_storage.allow_shallow_clones !== 'boolean'
  ) {
    throw new Error(
      'Config error: execution.branch_storage.allow_shallow_clones must be a boolean'
    );
  }
  if (
    config.execution?.branch_storage?.borrow_base_objects !== undefined &&
    typeof config.execution.branch_storage.borrow_base_objects !== 'boolean'
  ) {
    throw new Error('Config error: execution.branch_storage.borrow_base_objects must be a boolean');
  }
  only(config.security, 'security', ['csp', 'cors', 'git_config_parameters']);
  only(config.security?.csp, 'security.csp', [
    'extras',
    'override',
    'report_uri',
    'report_only',
    'disabled',
  ]);
  only(config.security?.cors, 'security.cors', [
    'mode',
    'origins',
    'credentials',
    'methods',
    'allowed_headers',
    'max_age_seconds',
    'allow_sandpack',
  ]);
  only(config.security?.git_config_parameters, 'security.git_config_parameters', [
    'extras',
    'override',
  ]);
  only(legacyConfig.branches, 'branches', RETIRED_CONFIG_KEYS.branches);
  only(config.teammates, 'teammates', ['framework_repo_url']);
  only(config.paths, 'paths', ['data_home']);
  only(config.analytics, 'analytics', ['enabled', 'client', 'filters', 'plugins']);
  only(config.analytics?.client, 'analytics.client', ['app', 'version', 'debug']);
  only(config.analytics?.filters, 'analytics.filters', ['exclude_events']);
  for (const [index, plugin] of (config.analytics?.plugins ?? []).entries()) {
    only(plugin, `analytics.plugins[${index}]`, ['type', 'enabled', 'options']);
    switch (plugin.type) {
      case 'stdout':
        only(plugin.options, `analytics.plugins[${index}].options`, ['pretty']);
        break;
      case 'http_batch':
        only(plugin.options, `analytics.plugins[${index}].options`, [
          'url',
          'flush_interval_ms',
          'max_batch_size',
          'timeout_ms',
          'headers',
        ]);
        break;
      default: {
        const unsupported: never = plugin;
        throw new Error(
          `Config error: analytics.plugins[${index}].type '${String((unsupported as { type?: unknown }).type)}' is not supported. Use 'stdout' or 'http_batch'.`
        );
      }
    }
  }
  only(config.telemetry, 'telemetry', [
    'enabled',
    'instance_id',
    'endpoint',
    'write_key',
    'debug',
    'timeout_ms',
    'flush_interval_ms',
    'max_batch_size',
    'install_ping_sent_at',
    'last_daemon_active_day',
    'last_usage_summary_day',
    'last_reported_version',
  ]);
  if (
    config.metrics !== undefined &&
    (!config.metrics || typeof config.metrics !== 'object' || Array.isArray(config.metrics))
  ) {
    throw new Error('Config error: metrics must be an object');
  }
  only(config.metrics, 'metrics', ['statsd', 'apm']);
  only(config.metrics?.statsd, 'metrics.statsd', [
    'enabled',
    'host',
    'port',
    'prefix',
    'global_tags',
  ]);
  only(config.metrics?.apm, 'metrics.apm', ['trace_services']);
  validateStatsDConfig(config.metrics?.statsd);
  validateApmConfig(config.metrics?.apm);
  only(legacyConfig.onboarding, 'onboarding', [
    ...RETIRED_CONFIG_KEYS.onboarding,
    'frameworkRepoUrl',
  ]);
  only(config.multi_tenancy, 'multi_tenancy', [
    'filesystem_isolation_enabled',
    'tenants_base_folder',
    'mode',
    'static_tenant_id',
    'auth_claim',
    'trusted_header',
  ]);
  // The catalog is the file checked into this repository, so it has nothing to
  // configure. The section stays loadable because a config file naming it must
  // not stop a daemon from booting on upgrade; the keys are read and ignored.
  only(legacyConfig.mcp_catalog, 'mcp_catalog', RETIRED_CONFIG_KEYS.mcp_catalog);
  if (unknownPaths.length > 0) {
    const summary = `unrecognized ${unknownPaths.length === 1 ? 'key' : 'keys'}: ${unknownPaths.join(', ')}`;
    if (resolveUnknownConfigKeyPolicy() === 'warn') {
      console.warn(
        `[config] Ignoring ${summary} (AGOR_UNKNOWN_CONFIG_KEYS=warn). This tolerates ` +
          'config written for a newer daemon; use the default (error) in dev/CI to catch typos.'
      );
    } else {
      throw new Error(`Config error: ${summary}`);
    }
  }

  assertSupportedUnixUserMode(config.execution?.unix_user_mode);

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
}

/**
 * Validate a preloaded/programmatic config through the same raw boundary used
 * for YAML. Daemon startup calls this before applying environment overrides.
 */
export function assertValidRawConfig(config: AgorConfig): void {
  validateConfig(config);
}

/** Return the deployment identity after enforcing the daemon startup invariant. */
export function requireDeploymentId(config: AgorConfig): string {
  const deploymentId = config.daemon?.deployment_id;
  if (
    typeof deploymentId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(deploymentId)
  ) {
    throw new Error("Config error: 'daemon.deployment_id' is required and must be a valid UUID");
  }
  return deploymentId;
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
    throw configLoadError(configPath, error);
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
 * Explicit upgrade escape hatch for configs created before deployment identity
 * became mandatory. This is deliberately not a relaxed config loader: the
 * returned value is validated only after the generated identity is inserted.
 */
export async function migrateConfigDeploymentId(
  filePath = getConfigPath(),
  deploymentId = randomUUID()
): Promise<{ config: AgorConfig; deploymentId: string; backupPath: string }> {
  const content = await fs.readFile(filePath, 'utf-8');
  const parsed = (yaml.load(content) ?? {}) as AgorConfig;
  if (parsed.daemon?.deployment_id) {
    validateConfig(parsed);
    try {
      requireDeploymentId(parsed);
      return { config: parsed, deploymentId: parsed.daemon.deployment_id, backupPath: filePath };
    } catch {
      // The explicitly-confirmed migration also repairs malformed legacy IDs.
    }
  }
  parsed.daemon = { ...parsed.daemon, deployment_id: deploymentId };
  validateConfig(parsed);
  requireDeploymentId(parsed);

  const backupPath = `${filePath}.backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  await fs.copyFile(filePath, backupPath, fs.constants.COPYFILE_EXCL);
  const stat = await fs.stat(filePath);
  const tempPath = `${filePath}.rewrite-${process.pid}-${randomUUID()}`;
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(tempPath, 'wx', 0o600);
    await handle.writeFile(yaml.dump(parsed, { indent: 2, lineWidth: 120, noRefs: true }), 'utf-8');
    // open(2)'s requested mode is filtered by the process umask. Apply the
    // original operator-selected bits through the already-open inode before
    // publishing the replacement.
    await handle.chmod(stat.mode & 0o7777);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(tempPath, filePath);
  } finally {
    await handle?.close();
    await fs.rm(tempPath, { force: true });
  }
  invalidateConfigCache();
  return { config: parsed, deploymentId, backupPath };
}

/** Raised when immutable deployment config has already been published. */
export class ConfigAlreadyExistsError extends Error {
  constructor(public readonly configPath: string) {
    super(`Refusing to overwrite existing config: ${configPath}`);
    this.name = 'ConfigAlreadyExistsError';
  }
}

/** Raised when a filesystem cannot provide atomic create-without-replace. */
export class AtomicConfigPublicationUnsupportedError extends Error {
  constructor(
    public readonly configPath: string,
    public readonly filesystemErrorCode: string
  ) {
    super(
      `Cannot atomically create ${configPath}: the containing filesystem does not support same-directory hard links (${filesystemErrorCode}). Run Agor with a home directory on a filesystem with hard-link support, or provision config.yaml through configuration management before starting Agor.`
    );
    this.name = 'AtomicConfigPublicationUnsupportedError';
  }
}

const HARD_LINK_UNSUPPORTED_ERROR_CODES = new Set([
  'ENOSYS',
  'ENOTSUP',
  'EOPNOTSUPP',
  'EPERM',
  'EXDEV',
]);

async function syncContainingDirectory(filePath: string): Promise<void> {
  // Node cannot open directories as files on Windows. link(2) still provides
  // atomic publication there, but directory fsync is a POSIX durability step.
  if (process.platform === 'win32') return;

  const directoryHandle = await fs.open(path.dirname(filePath), 'r');
  try {
    await directoryHandle.sync();
  } finally {
    await directoryHandle.close();
  }
}

/**
 * Save config to ~/.agor/config.yaml without replacing an existing file.
 *
 * Invalidates the in-memory cache so the next load reflects the fresh value.
 */
export async function createInitialConfig(config: AgorConfig = getDefaultConfig()): Promise<void> {
  validateConfig(config);
  // Create a missing state home privately, but preserve any pre-created
  // operator-managed directory, bind mount, group/ACL policy, or symlink.
  await ensureAgorHome(getAgorHome());
  const configPath = getConfigPath();
  const content = [
    '# Agor operator configuration',
    '#',
    '# This file is deployment-owned immutable runtime input. Agor will not',
    '# rewrite it after initialization. Edit it (or its IaC source) explicitly',
    '# and restart the daemon. Environment overrides take precedence where',
    '# documented: https://agor.live/guide/config-yaml',
    '#',
    yaml.dump(config, { indent: 2, lineWidth: 120, noRefs: true }),
  ].join('\n');

  // Node has no portable rename-without-replace primitive. Publish a fully
  // written same-directory inode with link(2): the hard-link creation is atomic
  // and fails with EEXIST rather than replacing operator-owned configuration.
  const tempPath = `${configPath}.create-${process.pid}-${randomUUID()}`;
  let handle: fs.FileHandle | undefined;
  let published = false;
  try {
    handle = await fs.open(tempPath, 'wx', 0o600);
    await handle.writeFile(content, 'utf-8');
    // Guarantee the documented mode even when the process has an unusually
    // restrictive umask. The descriptor pins the inode we are publishing.
    await handle.chmod(0o600);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.link(tempPath, configPath);
    published = true;
    await syncContainingDirectory(configPath);
  } catch (error) {
    const errorCode = (error as NodeJS.ErrnoException).code;
    if (!published && errorCode === 'EEXIST') {
      throw new ConfigAlreadyExistsError(configPath);
    }
    if (!published && errorCode && HARD_LINK_UNSUPPORTED_ERROR_CODES.has(errorCode)) {
      throw new AtomicConfigPublicationUnsupportedError(configPath, errorCode);
    }
    throw error;
  } finally {
    await handle?.close();
    await fs.rm(tempPath, { force: true });
  }
  invalidateConfigCache();
}

/**
 * Destructively rewrite config.yaml.
 *
 * This deliberately awkward API is reserved for the explicitly-confirmed CLI
 * escape hatch. Runtime, daemon, service, API, MCP, upgrade, and UI code must
 * never call it. Atomic replacement avoids partial YAML and preserves the
 * existing file's permission bits.
 */
async function rewriteConfigFile(
  config: AgorConfig,
  options: { acknowledgedFormattingLoss: true }
): Promise<void> {
  if (options.acknowledgedFormattingLoss !== true) {
    throw new Error('Destructive config rewrite was not explicitly acknowledged');
  }
  validateConfig(config);
  const configPath = getConfigPath();
  const stat = await fs.stat(configPath);
  const tempPath = `${configPath}.rewrite-${process.pid}-${randomUUID()}`;
  const content = yaml.dump(config, { indent: 2, lineWidth: 120, noRefs: true });
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(tempPath, 'wx', 0o600);
    await handle.writeFile(content, 'utf-8');
    // Preserve the existing operator-selected mode exactly; open(2) alone
    // cannot do so because the ambient umask filters its mode argument.
    await handle.chmod(stat.mode & 0o7777);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(tempPath, configPath);
  } finally {
    await handle?.close();
    await fs.rm(tempPath, { force: true });
  }
  invalidateConfigCache();
}

/** Test-only coverage for atomic replacement semantics. */
export async function rewriteConfigForTests(config: AgorConfig): Promise<void> {
  if (process.env.NODE_ENV !== 'test')
    throw new Error('rewriteConfigForTests is unavailable outside tests');
  await rewriteConfigFile(config, { acknowledgedFormattingLoss: true });
}

/** Test-fixture helper. Production code must use createInitialConfig or the guarded CLI. */
export async function saveConfigForTests(config: AgorConfig): Promise<void> {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('saveConfigForTests is unavailable outside tests');
  }
  try {
    await createInitialConfig(config);
  } catch (error) {
    if (!(error instanceof ConfigAlreadyExistsError)) throw error;
    await rewriteConfigFile(config, { acknowledgedFormattingLoss: true });
  }
}

/**
 * Get default config
 */
export function getDefaultConfig(): AgorConfig {
  return {
    daemon: {
      port: DAEMON.DEFAULT_PORT,
      host: DAEMON.DEFAULT_HOST,
      mcpEnabled: true, // Default: Enable built-in MCP server
    },
    ui: {
      port: 5173,
      host: 'localhost',
    },
    identity: {
      password_policy: AgorPasswordPolicyProfile.SECURE,
    },
    execution: {
      session_token_expiration_ms: 86400000, // 24 hours
      session_token_max_uses: 1, // Single-use tokens
      mcp_token_expiration_ms: MCP_TOKEN.DEFAULT_EXPIRATION_MS,
      executor_heartbeat: resolveExecutorHeartbeatConfig(),
    },
    analytics: getDefaultAnalyticsConfig(),
    telemetry: {},
    metrics: {
      statsd: {
        enabled: false,
        host: '127.0.0.1',
        port: 8125,
        prefix: 'agor.daemon.',
        global_tags: {},
      },
      apm: {
        trace_services: 'off',
      },
    },
    multi_tenancy: {
      filesystem_isolation_enabled: false,
      tenants_base_folder: '~/.agor/tenants',
      mode: 'static',
      static_tenant_id: 'default',
    },
    uploads: {
      location: '~/.agor',
      max_age_days: 30,
      max_file_size_mb: 50,
    },
  };
}

/**
 * Materialize YAML plus supported deployment-environment overrides into one
 * effective snapshot. This is read-only: callers may display/export the
 * result, but Agor never writes it back automatically.
 */
export function resolveEffectiveConfig(
  config: AgorConfig,
  env: NodeJS.ProcessEnv = process.env
): AgorConfig {
  const defaults = getDefaultConfig();
  const port = env.PORT ? Number.parseInt(env.PORT, 10) : undefined;
  const statsdEnabled = parseOptionalBooleanEnvironmentValue(
    env.AGOR_STATSD_ENABLED,
    'AGOR_STATSD_ENABLED'
  );
  const statsdPort = parseOptionalPortEnvironmentValue(env.AGOR_STATSD_PORT, 'AGOR_STATSD_PORT');
  const apmTraceServices = parseOptionalApmTraceDepthEnvironmentValue(env.AGOR_APM_TRACE_SERVICES);
  const externalLaunch = resolveEffectiveExternalLaunchConfig(config.external_launch, env);

  // Resolve the effective Unix isolation mode (env override wins) so the
  // `sandbox` mode can imply the rest of its machinery.
  // Compose exports an empty string when AGOR_UNIX_USER_MODE is unset. Treat
  // that as no override, matching the conditional merge below.
  const configuredUnixMode = env.AGOR_UNIX_USER_MODE || config.execution?.unix_user_mode;
  assertSupportedUnixUserMode(configuredUnixMode);
  const effectiveUnixMode = configuredUnixMode ?? 'simple';
  const sandboxIsolation = effectiveUnixMode === 'sandbox';

  // Fold config file + env vars + `sandbox`-mode implications into ONE sandbox
  // settings object (a single `sandbox:` key below).
  //
  // `unix_user_mode: sandbox` is a NAMED SECURITY MODE, so its core invariants
  // are NON-NEGOTIABLE: the sandbox is on, the home is per-owner, and it fails
  // closed. Operator config/env may NOT weaken these (a "sandbox" that silently
  // runs with a shared daemon home or spawns unsandboxed would violate the
  // contract). Other tunables (include/protect_secrets/extras) are still
  // honored. If you want a tunable standalone sandbox, use `unix_user_mode` !=
  // `sandbox` with `sandbox.enabled: true` and set home_mode/fail explicitly.
  const envSandboxEnabled = env.AGOR_SANDBOX_ENABLED === 'true';
  // env home_mode override applies ONLY outside sandbox mode (in sandbox mode it
  // is forced to per_user). env wins over the config file, matching other
  // AGOR_* overrides.
  const envHomeMode =
    env.AGOR_SANDBOX_HOME_MODE === 'per_user' || env.AGOR_SANDBOX_HOME_MODE === 'shared'
      ? env.AGOR_SANDBOX_HOME_MODE
      : undefined;
  const envSdkHomeMode = parseOptionalSdkHomeModeEnvironmentValue(env.AGOR_SANDBOX_SDK_HOME_MODE);
  let resolvedSandbox = config.execution?.sandbox;
  if (sandboxIsolation) {
    resolvedSandbox = {
      ...config.execution?.sandbox,
      // forced — cannot be weakened by config or env in sandbox mode
      enabled: true,
      home_mode: 'per_user',
      fail_if_unavailable: true,
    };
  } else if (envSandboxEnabled || envHomeMode) {
    resolvedSandbox = {
      ...config.execution?.sandbox,
      ...(envSandboxEnabled ? { enabled: true } : {}),
      ...(envHomeMode ? { home_mode: envHomeMode } : {}),
    };
  }
  // SDK-home relocation is an independent rollout control: setting it must
  // not implicitly enable or weaken the filesystem sandbox. The rich/full
  // development profile opts in explicitly, while ordinary deployments keep
  // the legacy-safe `inherit` default when neither YAML nor env names a mode.
  if (envSdkHomeMode) {
    resolvedSandbox = { ...resolvedSandbox, sdk_home_mode: envSdkHomeMode };
  }
  const resolvedExecutorResponse =
    defaults.execution?.executor_response ||
    config.execution?.executor_response ||
    env.AGOR_EXECUTOR_RESPONSE_ORIGIN_URL
      ? {
          ...defaults.execution?.executor_response,
          ...config.execution?.executor_response,
          ...(env.AGOR_EXECUTOR_RESPONSE_ORIGIN_URL
            ? { origin_url: env.AGOR_EXECUTOR_RESPONSE_ORIGIN_URL }
            : {}),
        }
      : undefined;

  const resolved: AgorConfig = {
    ...defaults,
    ...config,
    daemon: {
      ...defaults.daemon,
      ...config.daemon,
      ...(Number.isSafeInteger(port) ? { port } : {}),
      ...(env.DAEMON_HOST ? { host: env.DAEMON_HOST } : {}),
      ...(env.AGOR_JWT_SECRET ? { jwtSecret: env.AGOR_JWT_SECRET } : {}),
      ...(env.AGOR_MASTER_SECRET ? { masterSecret: env.AGOR_MASTER_SECRET } : {}),
      ...(env.INSTANCE_LABEL ? { instanceLabel: env.INSTANCE_LABEL } : {}),
    },
    ui: { ...defaults.ui, ...config.ui },
    identity: { ...defaults.identity, ...config.identity },
    ...(externalLaunch ? { external_launch: externalLaunch } : {}),
    execution: {
      ...defaults.execution,
      ...config.execution,
      ...(resolvedExecutorResponse ? { executor_response: resolvedExecutorResponse } : {}),
      ...(env.AGOR_RBAC_ENABLED === 'true' ? { branch_rbac: true } : {}),
      ...(env.AGOR_UNIX_USER_MODE
        ? {
            unix_user_mode: env.AGOR_UNIX_USER_MODE as NonNullable<
              AgorConfig['execution']
            >['unix_user_mode'],
          }
        : {}),
      // Folded sandbox settings (config file + AGOR_SANDBOX_* env + `sandbox`
      // isolation-mode implications). Computed above. AGOR_SANDBOX_ENABLED /
      // AGOR_SANDBOX_HOME_MODE are used by the `sandbox` .agor.yml env variants.
      ...(resolvedSandbox ? { sandbox: resolvedSandbox } : {}),
      // `sandbox` isolation mode requires RBAC to be active (branch authorization
      // is what the mount policy enforces). Force it on last so it wins.
      ...(sandboxIsolation ? { branch_rbac: true } : {}),
    },
    paths: {
      ...defaults.paths,
      ...config.paths,
      // Project the deployment override into the immutable effective snapshot.
      // Runtime services must consume this value instead of consulting the
      // environment or re-reading config.yaml on each request.
      ...(env.AGOR_DATA_HOME ? { data_home: expandHomePath(env.AGOR_DATA_HOME) } : {}),
    },
    analytics: { ...defaults.analytics, ...config.analytics },
    telemetry: {
      ...defaults.telemetry,
      ...config.telemetry,
      ...(env.AGOR_TELEMETRY === '1' ? { enabled: true } : {}),
      ...(env.AGOR_TELEMETRY === '0' || env.DO_NOT_TRACK === '1' ? { enabled: false } : {}),
      ...(env.AGOR_TELEMETRY_ENDPOINT ? { endpoint: env.AGOR_TELEMETRY_ENDPOINT } : {}),
      ...(env.AGOR_TELEMETRY_WRITE_KEY ? { write_key: env.AGOR_TELEMETRY_WRITE_KEY } : {}),
    },
    metrics: {
      ...defaults.metrics,
      ...config.metrics,
      statsd: {
        ...defaults.metrics?.statsd,
        ...config.metrics?.statsd,
        ...(statsdEnabled !== undefined ? { enabled: statsdEnabled } : {}),
        ...(env.AGOR_STATSD_HOST ? { host: env.AGOR_STATSD_HOST } : {}),
        ...(statsdPort !== undefined ? { port: statsdPort } : {}),
        ...(env.AGOR_STATSD_PREFIX ? { prefix: env.AGOR_STATSD_PREFIX } : {}),
      },
      apm: {
        ...defaults.metrics?.apm,
        ...config.metrics?.apm,
        ...(apmTraceServices !== undefined ? { trace_services: apmTraceServices } : {}),
      },
    },
    uploads: { ...defaults.uploads, ...config.uploads },
    multi_tenancy: { ...defaults.multi_tenancy, ...config.multi_tenancy },
  };
  validateStatsDConfig(resolved.metrics?.statsd);
  validateApmConfig(resolved.metrics?.apm);
  return resolved;
}

/**
 * Reject execution and authorization combinations that cannot satisfy the
 * selected deployment contract. Call this on the resolved effective config so
 * environment-derived settings are covered as well as YAML settings.
 */
export function assertValidEffectiveExecutionConfig(config: AgorConfig): void {
  const execution = config.execution;

  // Tenant identity prevents cross-tenant reads; it does not authorize one
  // member to every board, branch, Session, file, or executor in that tenant.
  // Validate this after environment projection so the named `sandbox` mode's
  // branch-RBAC implication and AGOR_RBAC_ENABLED are both honored.
  if (config.multi_tenancy?.mode === 'required_from_auth' && execution?.branch_rbac !== true) {
    throw new Error(
      'Config error: multi_tenancy.required_from_auth requires execution.branch_rbac: true; ' +
        'tenant isolation is not a substitute for board and branch authorization.'
    );
  }

  if (!execution) return;

  const response = resolveExecutorResponseConfig(execution.executor_response);

  // Enforced here, NOT in the raw config.yaml parse: one shared config.yaml
  // legitimately declares the protocol while each replica's exact origin
  // arrives via AGOR_EXECUTOR_RESPONSE_ORIGIN_URL, so the pairing is only
  // decidable after environment projection.
  if (response.externalProtocol && !response.originUrl) {
    throw new Error(
      'execution.executor_response.external_protocol requires an exact origin_url: set ' +
        'execution.executor_response.origin_url or the AGOR_EXECUTOR_RESPONSE_ORIGIN_URL ' +
        'environment variable for this daemon replica.'
    );
  }

  if (execution.unix_user_mode === 'delegated' && !execution.executor_command_template) {
    throw new Error(
      "execution.unix_user_mode 'delegated' requires execution.executor_command_template so execution is actually delegated to an external substrate."
    );
  }

  const retiredPlaceholders = execution.executor_command_template?.match(
    /\{(?:unix_user_uid|unix_user_gid)\}/g
  );
  if (retiredPlaceholders?.length) {
    throw new Error(
      `execution.executor_command_template uses removed placeholder(s): ${[...new Set(retiredPlaceholders)].join(', ')}. ` +
        'Use {unix_user} as the opaque delegated execution-home key instead.'
    );
  }

  if (
    execution.executor_command_template &&
    (response.externalProtocol !== EXECUTOR_RESPONSE_PROTOCOL || !response.originUrl)
  ) {
    throw new Error(
      'execution.executor_command_template requires request-mode response support: set ' +
        `execution.executor_response.external_protocol=${EXECUTOR_RESPONSE_PROTOCOL} and an exact ` +
        'execution.executor_response.origin_url for this daemon replica.'
    );
  }

  if (execution.sandbox?.enabled !== true) return;

  if (execution.executor_command_template) {
    throw new Error(
      'execution.sandbox.enabled is incompatible with execution.executor_command_template because ' +
        'templated executors run outside the daemon local sandbox. Enforce isolation in the external substrate instead.'
    );
  }
}

export function formatConfigYaml(config: AgorConfig): string {
  return yaml.dump(config, { indent: 2, lineWidth: 120, noRefs: true });
}

export interface DeploymentAgenticToolPolicy {
  managed: boolean;
  installed: ReadonlySet<InstallableAgenticTool>;
}

/** Capture the instance-global package policy once during daemon startup. */
export function resolveDeploymentAgenticToolPolicy(
  config: AgorConfig,
  env: NodeJS.ProcessEnv = process.env
): DeploymentAgenticToolPolicy {
  return {
    managed: env.AGOR_MANAGED_AGENTIC_TOOLS === '1',
    installed: new Set(config.agentic_tools?.installed ?? []),
  };
}

/** Instance-global package gate; tenant settings may narrow but never expand it. */
export function isDeploymentAgenticToolAvailable(
  tool: AgenticToolName,
  policy: DeploymentAgenticToolPolicy
): boolean {
  if (!policy.managed) return true;
  if (!isInstallableAgenticTool(tool)) return false;
  return policy.installed.has(tool);
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
    await createInitialConfig(getDefaultConfig());
  }
}

/**
 * Get a nested config value using dot notation
 *
 * Merges with default config to return effective values.
 *
 * @param key - Config key (e.g., "daemon.port")
 * @returns Value or undefined if not set
 */
export async function getConfigValue(key: string): Promise<string | boolean | number | undefined> {
  const config = await loadConfig();
  const defaults = getDefaultConfig();
  const {
    defaults: _retiredDefaults,
    display: _retiredDisplay,
    branches: _retiredBranches,
    onboarding: _retiredOnboarding,
    ...activeConfig
  } = config as AgorConfig & {
    defaults?: unknown;
    display?: unknown;
    branches?: unknown;
    onboarding?: unknown;
  };
  const {
    allowAnonymous: _retiredAllowAnonymous,
    requireAuth: _retiredRequireAuth,
    ...activeDaemon
  } = (config.daemon ?? {}) as NonNullable<AgorConfig['daemon']> & Record<string, unknown>;
  const { managed_envs_minimum_role: _retiredManagedEnvsMinimumRole, ...activeExecution } =
    (config.execution ?? {}) as NonNullable<AgorConfig['execution']> & Record<string, unknown>;

  // Merge config with defaults (deep merge for sections)
  const merged = {
    ...defaults,
    ...activeConfig,
    daemon: { ...defaults.daemon, ...activeDaemon },
    ui: { ...defaults.ui, ...config.ui },
    identity: { ...defaults.identity, ...config.identity },
    execution: { ...defaults.execution, ...activeExecution },
    paths: { ...defaults.paths, ...config.paths },
    analytics: { ...defaults.analytics, ...config.analytics },
    telemetry: { ...defaults.telemetry, ...config.telemetry },
    uploads: { ...defaults.uploads, ...config.uploads },
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
  return resolveDaemonUrl(await loadConfig());
}

/** Resolve the internal daemon URL from an already processed config snapshot. */
export function resolveDaemonUrl(config: AgorConfig): string {
  return process.env.DAEMON_URL
    ? normalizeHttpBaseUrl(process.env.DAEMON_URL, 'DAEMON_URL')
    : constructDaemonLocalUrl(config);
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

/** Construct `http://{host}:{port}` from daemon config + env overrides. */
function constructDaemonLocalUrl(config: AgorConfig): string {
  const defaults = getDefaultConfig();
  const envPort = process.env.PORT ? Number.parseInt(process.env.PORT, 10) : undefined;
  const port = envPort || config.daemon?.port || defaults.daemon?.port || DAEMON.DEFAULT_PORT;
  const host = config.daemon?.host || defaults.daemon?.host || DAEMON.DEFAULT_HOST;
  return `http://${host}:${port}`;
}

/**
 * Shared base URL resolver for browser-reachable URLs.
 *
 * All three public resolvers ({@link getBaseUrl}, {@link getDaemonBaseUrl},
 * {@link requirePublicBaseUrl}) differ only in which config key they prefer
 * and whether a missing explicit URL should throw.
 *
 * @param prefer - `'ui'` checks `ui.base_url` first (for browser entity links),
 *   `'daemon'` checks `daemon.base_url` first (for API endpoints / OAuth).
 * @param requireExplicit - When true, throws instead of falling back to localhost.
 */
function resolveBaseUrl(
  config: AgorConfig,
  prefer: 'ui' | 'daemon',
  requireExplicit?: boolean
): string {
  const first = prefer === 'ui' ? config.ui?.base_url : config.daemon?.base_url;
  const second = prefer === 'ui' ? config.daemon?.base_url : config.ui?.base_url;

  if (first) return validateBaseUrl(first);
  if (second) return validateBaseUrl(second);

  if (requireExplicit) {
    throw new PublicBaseUrlNotConfiguredError(
      'No public base URL configured. Set the AGOR_BASE_URL environment variable ' +
        'or `daemon.base_url` (preferred) / `ui.base_url` (legacy) in ~/.agor/config.yaml ' +
        "to the daemon's " +
        'browser-reachable URL (e.g. https://agor.example.com). This is required ' +
        'so OAuth providers can redirect users back to a URL their browser can reach — ' +
        'the localhost fallback only works for browsers on the daemon machine.'
    );
  }

  return constructDaemonLocalUrl(config);
}

/**
 * Get the daemon base URL for browser-reachable API endpoints
 * (e.g. artifact `AGOR_API_URL` grants).
 *
 * Distinct from {@link getDaemonUrl}, which uses `DAEMON_URL` for internal
 * backend-to-backend communication.
 *
 * Resolution order:
 * 1. AGOR_BASE_URL environment variable (highest priority)
 * 2. daemon.base_url from config.yaml
 * 3. ui.base_url from legacy one-origin configs
 * 4. Default daemon host and port
 */
export async function getDaemonBaseUrl(): Promise<string> {
  if (process.env.AGOR_BASE_URL) {
    return validateBaseUrl(process.env.AGOR_BASE_URL);
  }
  return resolveBaseUrl(await loadConfig(), 'daemon');
}

/**
 * Get base URL for external/user-facing UI links.
 *
 * Used to generate clickable URLs to sessions, boards, and other resources
 * that are sent to external platforms like Slack, email, etc.
 *
 * Resolution order:
 * 1. AGOR_BASE_URL environment variable (highest priority)
 * 2. ui.base_url from config.yaml
 * 3. daemon.base_url from config.yaml
 * 4. Default: http://localhost:{port} (constructed from daemon port)
 *
 * @returns Base URL without trailing slash (e.g., "https://agor.sandbox.preset.zone")
 */
export async function getBaseUrl(): Promise<string> {
  if (process.env.AGOR_BASE_URL) {
    return validateBaseUrl(process.env.AGOR_BASE_URL);
  }
  return resolveBaseUrl(await loadConfig(), 'ui');
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
 * Strict variant of {@link getDaemonBaseUrl} — required for any URL that will be handed
 * to a remote system (e.g. an OAuth `redirect_uri` registered with an upstream
 * provider) and then loaded by an end-user's browser.
 *
 * Resolution:
 * 1. `AGOR_BASE_URL` environment variable
 * 2. `daemon.base_url` from `~/.agor/config.yaml`
 * 3. Legacy `ui.base_url` fallback
 * 4. **Throws** {@link PublicBaseUrlNotConfiguredError}
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
  return resolveBaseUrl(await loadConfig(), 'daemon', true);
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
    throw configLoadError(configPath, error);
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

export interface ResolvedExecutionSecurityMode {
  /** App-layer branch ownership/visibility/action enforcement. */
  appRbacEnabled: boolean;
  /** Configured Unix execution mode with default applied. */
  unixUserMode: import('./types').UnixUserMode;
  /**
   * Whether every user must have a `unix_username` home key (delegated).
   * Session creation and executor/terminal launches fail loudly without one.
   */
  requiresExecutionHomeKey: boolean;
}

/**
 * Resolve the execution security posture from config.
 *
 * Keep this as the single semantic boundary between app-layer RBAC and
 * OS/filesystem isolation:
 * - `branch_rbac` controls Agor app permissions only.
 * - `delegated` requires per-user `unix_username` but performs no OS-level
 *   work on the daemon host — identity
 *   enforcement is delegated to the execution substrate.
 */
export function resolveExecutionSecurityMode(
  config: AgorConfig = loadConfigSync()
): ResolvedExecutionSecurityMode {
  const unixUserMode = config.execution?.unix_user_mode ?? 'simple';
  return {
    appRbacEnabled: config.execution?.branch_rbac === true,
    unixUserMode,
    requiresExecutionHomeKey: unixUserModeRequiresExecutionHomeKey(unixUserMode),
  };
}

/**
 * Whether an execution mode requires the transitional `unix_username`
 * execution-home key. Shared by config resolution and launch call sites.
 */
export function unixUserModeRequiresExecutionHomeKey(
  mode: import('./types').UnixUserMode
): boolean {
  return mode === 'delegated';
}

/**
 * Check if logical branch RBAC is enabled.
 *
 * This controls app-level branch ownership/visibility. It does not necessarily
 * imply local filesystem isolation; simple mode may enable branch RBAC while
 * running filesystem work as the daemon user.
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
export function resolveBranchStorageConfig(config?: AgorConfig): ResolvedBranchStorageConfig {
  let raw: import('./types').AgorBranchStorageSettings | undefined;
  if (config) {
    raw = config.execution?.branch_storage;
  } else {
    try {
      raw = loadConfigSync().execution?.branch_storage;
    } catch {
      // Preserve the standalone helper's safe legacy fallback when no
      // effective config is supplied. Daemon boundaries pass app config
      // explicitly so their policy never depends on an ambient config file.
      raw = undefined;
    }
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
  return {
    defaultMode,
    allowedModes: allowed,
    allowShallowClones: raw?.allow_shallow_clones ?? true,
  };
}

/**
 * Throw a clear error if `mode` isn't in the operator-allowed set.
 * Centralised so the same wording appears across the daemon service, the
 * REST route, and the MCP tool.
 */
export function ensureBranchStorageModeAllowed(
  mode: import('./types').BranchStorageMode,
  config?: AgorConfig
): void {
  const { allowedModes } = resolveBranchStorageConfig(config);
  if (!allowedModes.includes(mode)) {
    throw new Error(
      `storage_mode='${mode}' is not enabled on this Agor instance. ` +
        `Enable it by adding '${mode}' to execution.branch_storage.allowed_modes ` +
        `in ~/.agor/config.yaml. Currently allowed: ${allowedModes.map((m) => `'${m}'`).join(', ')}.`
    );
  }
}

/** Reject shallow branch clones when the operator requires complete history. */
export function ensureBranchCloneDepthAllowed(
  cloneDepth: number | undefined,
  config?: AgorConfig
): void {
  if (cloneDepth === undefined) return;
  if (!resolveBranchStorageConfig(config).allowShallowClones) {
    throw new Error(
      'clone_depth is unavailable on this Agor instance because execution.branch_storage.allow_shallow_clones is false. Omit clone_depth to create a full clone.'
    );
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
    return resolveDataHomeFromConfig(loadConfigSync());
  } catch {
    // Config load failed, fall through to default
  }

  // 3. Default to AGOR_HOME (backward compatible)
  return getAgorHome();
}

/** Resolve the data root from an already-loaded config snapshot. */
export function resolveDataHomeFromConfig(
  config: { readonly paths?: { readonly data_home?: string } },
  agorHome = getAgorHome()
): string {
  return config.paths?.data_home ? expandHomePath(config.paths.data_home) : agorHome;
}

/**
 * Pure tenant-data-root policy shared by sync and async config loaders.
 */
export function resolveTenantDataRootFromConfig(
  config: {
    readonly multi_tenancy?: {
      readonly filesystem_isolation_enabled?: boolean;
      readonly tenants_base_folder?: string;
    };
  },
  dataHome: string,
  agorHome: string,
  tenantId?: string
): string {
  if (config.multi_tenancy?.filesystem_isolation_enabled !== true) {
    return dataHome;
  }

  const normalizedTenantId = tenantId?.trim();
  if (
    !normalizedTenantId ||
    normalizedTenantId === '.' ||
    normalizedTenantId === '..' ||
    normalizedTenantId.includes('/') ||
    normalizedTenantId.includes('\\')
  ) {
    throw new Error(
      'A valid tenant id is required when multi_tenancy.filesystem_isolation_enabled is true'
    );
  }

  const tenantsBase = resolveTenantsBaseFolderFromConfig(config, agorHome);
  return path.join(tenantsBase, normalizedTenantId);
}

/** Resolve the configured parent of all filesystem-isolated tenant roots. */
export function resolveTenantsBaseFolderFromConfig(
  config: { readonly multi_tenancy?: { readonly tenants_base_folder?: string } },
  agorHome = getAgorHome()
): string {
  const configuredBase = config.multi_tenancy?.tenants_base_folder || '~/.agor/tenants';
  const expandedBase = expandHomePath(configuredBase);
  return path.isAbsolute(expandedBase) ? expandedBase : path.resolve(agorHome, expandedBase);
}

/**
 * Resolve the root containing tenant-owned filesystem data.
 *
 * Single-tenant installs retain the historical data home. When filesystem
 * multi-tenancy is enabled, a tenant id is required and the result is
 * `<tenants_base_folder>/<tenantId>`.
 */
export function getTenantDataRoot(tenantId?: string): string {
  return resolveTenantDataRootFromConfig(loadConfigSync(), getDataHome(), getAgorHome(), tenantId);
}

/**
 * Get repos directory path
 *
 * Returns: $AGOR_DATA_HOME/repos
 *
 * @returns Absolute path to repos directory
 */
export function getReposDir(tenantId?: string): string {
  return path.join(getTenantDataRoot(tenantId), 'repos');
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
export function getBranchesDir(tenantId?: string): string {
  return path.join(getTenantDataRoot(tenantId), 'worktrees');
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
export function getBranchPath(repoSlug: string, branchName: string, tenantId?: string): string {
  return path.join(getBranchesDir(tenantId), repoSlug, branchName);
}

/**
 * Get the on-disk root for per-branch SDK homes.
 *
 * Returns: $AGOR_DATA_HOME/branch-homes
 *
 * A sibling of `worktrees/` and `homes/` (see {@link getBranchesDir},
 * `resolveOwnerHomeStore`). Purely additive — nothing existing moves. Inherits
 * filesystem-multitenancy isolation via {@link getTenantDataRoot}. See design
 * §6.2.
 *
 * @returns Absolute path to the branch-homes root
 */
export function getBranchHomesDir(tenantId?: string): string {
  return path.join(getTenantDataRoot(tenantId), 'branch-homes');
}

/**
 * Get the per-branch SDK home path for a specific branch.
 *
 * Returns: $AGOR_DATA_HOME/branch-homes/<branchId>
 *
 * Keyed by the immutable `branchId` — NOT the branch name — because names are
 * mutable and non-unique across repos. This is the single resolver that derives
 * the path from the branch id, so the on-disk location cannot drift or be
 * injected (the branch record only stores a boolean/enum intent, never a path;
 * see design §9.2).
 *
 * @param branchId - The branch's immutable id
 * @returns Absolute path to the branch's SDK home
 */
export function getBranchHomePath(branchId: string, tenantId?: string): string {
  if (!branchId || branchId.includes('/') || branchId.includes('..')) {
    throw new Error(`Invalid branchId for SDK home path: ${JSON.stringify(branchId)}`);
  }
  return path.join(getBranchHomesDir(tenantId), branchId);
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

/** Async counterpart to {@link getTenantDataRoot}. */
export async function getTenantDataRootAsync(tenantId?: string): Promise<string> {
  const [config, dataHome] = await Promise.all([loadConfig(), getDataHomeAsync()]);
  return resolveTenantDataRootFromConfig(config, dataHome, getAgorHome(), tenantId);
}

/**
 * Get repos directory path (async version)
 *
 * @returns Absolute path to repos directory
 */
export async function getReposDirAsync(tenantId?: string): Promise<string> {
  return path.join(await getTenantDataRootAsync(tenantId), 'repos');
}

/**
 * Get branches directory path (async version).
 *
 * Same on-disk-dir compat as {@link getBranchesDir} — value is
 * `worktrees/`, helper name is Branch-conceptual.
 *
 * @returns Absolute path to branches directory
 */
export async function getBranchesDirAsync(tenantId?: string): Promise<string> {
  return path.join(await getTenantDataRootAsync(tenantId), 'worktrees');
}
