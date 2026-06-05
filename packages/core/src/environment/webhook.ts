import type { EnvironmentCommandType } from '../unix/environment-command-spawn.js';
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

  if (!isAllowedHealthCheckUrl(normalized)) {
    throw new Error(`${fieldName} is blocked by Agor's managed-environment webhook policy`);
  }

  return normalized;
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

function commandTypeLabel(commandType: EnvironmentCommandType): string {
  switch (commandType) {
    case 'start':
      return 'start';
    case 'stop':
      return 'stop';
    case 'nuke':
      return 'nuke';
    case 'logs':
      return 'logs';
    case 'health':
      return 'health';
  }
}

/**
 * Resolve the execution strategy for a rendered environment lifecycle field.
 * Pure helper used by the daemon service and tests.
 */
export function resolveManagedEnvCommandExecution(
  command: string,
  mode: ManagedEnvExecutionMode,
  commandType: EnvironmentCommandType
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
