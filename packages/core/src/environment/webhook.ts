import { resolveVariant } from '../config/variant-resolver.js';
import type { RepoEnvironment } from '../types/branch.js';
import { isAllowedHealthCheckUrl, normalizeOptionalHttpUrl } from '../utils/url.js';

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

function hostnameEqualsOrEndsWith(hostname: string, suffix: string): boolean {
  return hostname === suffix || hostname.endsWith(`.${suffix}`);
}

function isBlockedIPv4(hostname: string): boolean {
  const parts = hostname.split('.');
  if (parts.length !== 4) return false;
  const octets = parts.map((part) => Number(part));
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return false;
  }
  const [a, b] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
}

function isBlockedIPv6(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!normalized.includes(':')) return false;
  const mappedIPv4 = normalized.match(/:ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mappedIPv4) return isBlockedIPv4(mappedIPv4[1]);

  const hextets = normalized.split(':').filter(Boolean);
  const mappedIndex = hextets.lastIndexOf('ffff');
  if (mappedIndex >= 0 && hextets.length - mappedIndex === 3) {
    const high = Number.parseInt(hextets[mappedIndex + 1], 16);
    const low = Number.parseInt(hextets[mappedIndex + 2], 16);
    if (
      Number.isInteger(high) &&
      Number.isInteger(low) &&
      high >= 0 &&
      high <= 0xffff &&
      low >= 0 &&
      low <= 0xffff
    ) {
      const ipv4 = `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
      return isBlockedIPv4(ipv4);
    }
  }

  const firstHextet = Number.parseInt(hextets[0] ?? '', 16);
  return (
    normalized === '::1' ||
    normalized === '::' ||
    (Number.isInteger(firstHextet) && firstHextet >= 0xfe80 && firstHextet <= 0xfebf) ||
    (Number.isInteger(firstHextet) && firstHextet >= 0xfc00 && firstHextet <= 0xfdff)
  );
}

/**
 * Webhook destinations have a stricter SSRF posture than health checks.
 *
 * Health checks intentionally allow localhost/private networks because they
 * often probe branch-local services. Managed environment webhooks are outbound
 * orchestration calls, so V1 allows public HTTP(S) destinations only. This is
 * a syntactic guard (no DNS resolution); operators should still point webhooks
 * at trusted orchestration services.
 */
export function isAllowedManagedEnvWebhookUrl(urlString: string): boolean {
  let normalized: string | undefined;
  try {
    normalized = normalizeOptionalHttpUrl(urlString, 'managed environment webhook');
  } catch {
    return false;
  }
  if (!normalized) return false;

  const url = new URL(normalized);
  const hostname = url.hostname.toLowerCase();

  if (url.username || url.password) return false;
  if (hostname === 'localhost' || hostnameEqualsOrEndsWith(hostname, 'localhost')) return false;
  if (hostname === 'metadata.google.internal') return false;
  if (hostnameEqualsOrEndsWith(hostname, 'internal')) return false;
  if (hostname.endsWith('.local')) return false;
  if (isBlockedIPv4(hostname)) return false;
  if (isBlockedIPv6(hostname)) return false;

  return true;
}

/**
 * Normalize and validate a managed-environment webhook URL.
 *
 * V1 deliberately supports only GET to HTTP(S) URLs. It blocks obvious cloud
 * metadata/link-local targets and URL credentials, but it is not a complete
 * SSRF sandbox; operators should point webhooks at trusted orchestration
 * services and avoid embedding secrets in query strings.
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
