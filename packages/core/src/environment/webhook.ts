import { resolveVariant } from '../config/variant-resolver.js';
import type { RepoEnvironment } from '../types/branch.js';
import {
  isAllowedHealthCheckUrl,
  isPublicHttpUrl,
  normalizeOptionalHttpUrl,
} from '../utils/url.js';

/**
 * How Agor executes rendered managed-environment lifecycle fields.
 *
 * - `hybrid`: backwards-compatible shell command execution. URL-shaped fields
 *   are treated as webhooks instead of shell strings.
 * - `webhook-only`: operator lockdown mode. Every executable lifecycle field
 *   must be an HTTP(S) URL and is invoked with GET; shell commands are rejected.
 */
export type ManagedEnvExecutionMode = 'hybrid' | 'webhook-only';

export const MANAGED_ENV_LIFECYCLE_FIELDS = ['start', 'stop', 'nuke', 'logs'] as const;

export type ManagedEnvLifecycleField = (typeof MANAGED_ENV_LIFECYCLE_FIELDS)[number];
export type ManagedEnvCommandType = ManagedEnvLifecycleField;

export type ManagedEnvCommandExecution =
  | { kind: 'command'; command: string }
  | { kind: 'webhook'; url: string };

export const MANAGED_ENV_EXECUTION_MODE_DEFAULT: ManagedEnvExecutionMode = 'hybrid';

export const MANAGED_ENV_WEBHOOK_DOCS_PATH = '/guide/environment-configuration#webhook-only-mode';

const HTTP_URL_PREFIX = /^https?:\/\//i;

/**
 * "URL-shaped" intentionally means explicit HTTP(S) URL. Bare hostnames like
 * `example.com/hook` remain shell commands in default mode and are rejected in
 * webhook-only mode so execution semantics are never guessed.
 */
export function isUrlShapedManagedEnvCommand(value: string): boolean {
  return HTTP_URL_PREFIX.test(value.trim());
}

/**
 * Managed-environment webhook destinations are public-HTTP(S) only.
 *
 * A webhook is an outbound orchestration call the daemon makes from a privileged
 * network position, so it must never reach loopback, RFC 1918, CGNAT,
 * link-local/cloud-metadata, or unique-local space. This is a syntactic
 * pre-filter (no DNS resolution) built on {@link isPublicHttpUrl}, which — unlike
 * the earlier dotted-quad check — also rejects the decimal/octal/hex and
 * IPv4-mapped spellings of those addresses, URL credentials, and non-HTTP
 * schemes.
 *
 * The pre-filter cannot see where a hostname resolves: `evil.example` passes
 * here and still answers with 169.254.169.254, and `169-254-169-254.sslip.io`
 * is a wildcard-DNS hostname that resolves to a blocked IP. The fetch itself
 * therefore goes through `createPinnedFetch`, which resolves the name, refuses
 * any private answer at connect time, and connects to the vetted address
 * (defeating DNS rebinding).
 */
export function isAllowedManagedEnvWebhookUrl(urlString: string): boolean {
  let normalized: string | undefined;
  try {
    normalized = normalizeOptionalHttpUrl(urlString, 'managed environment webhook');
  } catch {
    return false;
  }
  if (!normalized) return false;

  return isPublicHttpUrl(normalized);
}

/**
 * Normalize and validate a managed-environment webhook URL.
 *
 * Supports only GET to public HTTP(S) URLs and rejects URL credentials. This is
 * the config/render-time pre-filter; the authoritative SSRF control is the
 * connect-time DNS pin applied when the webhook is actually fetched (see
 * `executeEnvironmentWebhook`). Operators should still point webhooks at trusted
 * orchestration services and avoid embedding secrets in query strings.
 */
export function normalizeManagedEnvWebhookUrl(value: string, fieldName = 'environment webhook') {
  const normalized = normalizeOptionalHttpUrl(value, fieldName);
  if (!normalized) {
    throw new Error(`${fieldName} must be a valid http(s) URL`);
  }

  const parsed = new URL(normalized);
  if (parsed.username || parsed.password) {
    throw new Error(`${fieldName} must not include URL credentials`);
  }

  if (!isAllowedManagedEnvWebhookUrl(normalized)) {
    throw new Error(`${fieldName} is blocked by Agor's managed-environment webhook policy`);
  }

  return normalized;
}

export function validateManagedEnvLifecyclePolicy(
  lifecycleFields: Partial<Record<ManagedEnvLifecycleField, string | null | undefined>>,
  mode: ManagedEnvExecutionMode,
  context = 'managed environment'
): void {
  for (const field of MANAGED_ENV_LIFECYCLE_FIELDS) {
    const value = lifecycleFields[field];
    if (!value?.trim()) continue;

    if (isUrlShapedManagedEnvCommand(value)) {
      normalizeManagedEnvWebhookUrl(value, `${context} ${field} webhook`);
      continue;
    }

    if (mode === 'webhook-only') {
      throw new Error(
        `${context} ${field} must render to an http(s) URL webhook on this Agor instance`
      );
    }
  }
}

export function validateRepoEnvironmentLifecyclePolicy(
  env: RepoEnvironment,
  mode: ManagedEnvExecutionMode,
  context = 'repo environment'
): void {
  for (const variantName of Object.keys(env.variants)) {
    const resolved = resolveVariant(env, variantName);
    if (!resolved) continue;
    const lifecycleFields = {
      start: resolved.start,
      stop: resolved.stop,
      nuke: resolved.nuke,
      logs: resolved.logs,
    } satisfies Partial<Record<ManagedEnvLifecycleField, string | null | undefined>>;

    for (const field of MANAGED_ENV_LIFECYCLE_FIELDS) {
      const value = lifecycleFields[field];
      if (value?.includes('{{')) continue;
      validateManagedEnvLifecyclePolicy(
        { [field]: value },
        mode,
        `${context} variant "${variantName}"`
      );
    }
  }
}

export function validateRenderedManagedEnvUrlFields(fields: {
  health?: string | null;
  app?: string | null;
}): void {
  if (fields.health?.trim() && !isAllowedHealthCheckUrl(fields.health)) {
    throw new Error('managed environment health must render to an allowed http(s) URL');
  }
  normalizeOptionalHttpUrl(fields.app, 'managed environment app URL');
}

export function redactManagedEnvWebhookUrlForAudit(url: string): string {
  try {
    const parsed = new URL(url);
    const queryMarker = parsed.search ? '?[redacted]' : '';
    return `${parsed.origin}${parsed.pathname}${queryMarker}`;
  } catch {
    return '[invalid-url]';
  }
}

function commandTypeLabel(commandType: ManagedEnvCommandType): string {
  switch (commandType) {
    case 'start':
      return 'start';
    case 'stop':
      return 'stop';
    case 'nuke':
      return 'nuke';
    case 'logs':
      return 'logs';
  }
}

/**
 * Resolve the execution strategy for a rendered environment lifecycle field.
 * Pure helper used by the daemon service and tests.
 */
export function resolveManagedEnvCommandExecution(
  command: string,
  mode: ManagedEnvExecutionMode,
  commandType: ManagedEnvCommandType
): ManagedEnvCommandExecution {
  if (isUrlShapedManagedEnvCommand(command)) {
    return {
      kind: 'webhook',
      url: normalizeManagedEnvWebhookUrl(
        command,
        `environment ${commandTypeLabel(commandType)} webhook`
      ),
    };
  }

  if (mode === 'webhook-only') {
    throw new Error(
      `Managed environment ${commandTypeLabel(commandType)} is blocked: this Agor instance is configured for ` +
        `execution.managed_envs_execution_mode: webhook-only, so the rendered ${commandTypeLabel(commandType)} field ` +
        `must be an http(s) URL webhook. Re-render or update the repo's .agor.yml environment variant. ` +
        `Docs: ${MANAGED_ENV_WEBHOOK_DOCS_PATH}`
    );
  }

  return { kind: 'command', command };
}
