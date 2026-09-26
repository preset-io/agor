import { ENV_VAR_NAME_PATTERN } from './env-blocklist.js';
import { isAllowedEnvVar, TRUSTED_LAUNCHER_ENV_PREFIX } from './env-inheritance.js';
import { isPlainConfigRecord } from './plain-record.js';
import type { AgorAnalyticsHttpBatchPluginSettings, AgorAnalyticsSettings } from './types.js';

const POISON_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

export function isSafeAnalyticsKey(key: string): boolean {
  return !POISON_KEYS.has(key);
}

function invalid(field: string): never {
  // Never interpolate keys or values: even malformed configuration can contain credentials.
  throw new Error(`Config error: invalid analytics ${field}`);
}

function entries(value: unknown, field: string, limit: number): [string, unknown][] {
  if (!isPlainConfigRecord(value)) invalid(field);
  const result = Object.entries(value);
  if (result.length > limit) invalid(field);
  return result;
}

export function validateAnalyticsMetadata(config: AgorAnalyticsSettings): void {
  if (config.extras !== undefined) {
    for (const [key, value] of entries(config.extras, 'extras', 32)) {
      if (
        !isSafeAnalyticsKey(key) ||
        !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/.test(key) ||
        !(
          (typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= 1024) ||
          (typeof value === 'number' && Number.isFinite(value)) ||
          typeof value === 'boolean'
        )
      )
        invalid('extras');
    }
  }
  const client = config.client;
  if (client === undefined) return;
  if (!isPlainConfigRecord(client)) invalid('client');
  if (
    client.app !== undefined &&
    (typeof client.app !== 'string' ||
      !client.app.trim() ||
      Buffer.byteLength(client.app, 'utf8') > 256)
  )
    invalid('client.app');
  if (
    client.version !== undefined &&
    !(
      (typeof client.version === 'string' &&
        !!client.version.trim() &&
        Buffer.byteLength(client.version, 'utf8') <= 256) ||
      (typeof client.version === 'number' && Number.isFinite(client.version))
    )
  )
    invalid('client.version');
  if (client.debug !== undefined && typeof client.debug !== 'boolean') invalid('client.debug');
}

/** Validate config names without reading the environment or materializing any secret. */
export function validateAnalyticsHeaders(
  options: AgorAnalyticsHttpBatchPluginSettings['options']
): void {
  const seen = new Set<string>();
  for (const [kind, map] of [
    ['headers', options?.headers],
    ['headers_from_env', options?.headers_from_env],
  ] as const) {
    if (map === undefined) continue;
    for (const [name, value] of entries(map, kind, 32)) {
      const lower = name.toLowerCase();
      if (
        !isSafeAnalyticsKey(lower) ||
        name.length > 128 ||
        !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) ||
        seen.has(lower)
      )
        invalid('header names (invalid or case-insensitive conflict)');
      seen.add(lower);
      if (kind === 'headers_from_env') {
        if (
          typeof value !== 'string' ||
          value.length > 128 ||
          !ENV_VAR_NAME_PATTERN.test(value) ||
          isAllowedEnvVar(value) ||
          value.startsWith(TRUSTED_LAUNCHER_ENV_PREFIX)
        )
          invalid('headers_from_env variable name (must not be inherited by child processes)');
      } else if (!isValidAnalyticsHeaderValue(value, false)) invalid('headers value');
    }
  }
}

export function isValidAnalyticsHeaderValue(
  value: unknown,
  requireNonempty: boolean
): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 8192 &&
    (!requireNonempty || value.trim().length > 0) &&
    /^[\t\x20-\x7e]*$/.test(value)
  );
}
