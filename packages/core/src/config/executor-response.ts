import { EXECUTOR_NAME_PATTERN, EXECUTOR_RESPONSE_PROTOCOL } from '../executor-protocol';
import type { AgorExecutorResponseSettings } from './types';
import { resolveSafeIntegerInRange } from './validation';

export const EXECUTOR_RESPONSE_DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
export const EXECUTOR_RESPONSE_HARD_MAX_BYTES = 64 * 1024 * 1024;
export const EXECUTOR_RESPONSE_MIN_BYTES = 1024;
export const EXECUTOR_RESPONSE_DEFAULT_MAX_ACTIVE = 16;
export const EXECUTOR_RESPONSE_HARD_MAX_ACTIVE = 256;
export const EXECUTOR_RESPONSE_DEFAULT_TIMEOUT_MS = 5 * 60_000;
export const EXECUTOR_RESPONSE_MIN_TIMEOUT_MS = 1_000;
export const EXECUTOR_RESPONSE_HARD_MAX_TIMEOUT_MS = 24 * 60 * 60_000;

export interface ResolvedExecutorResponseConfig {
  maxResponseBytes: number;
  maxActiveRequests: number;
  defaultTimeoutMs: number;
  timeoutByCommand: Readonly<Record<string, number>>;
  originUrl?: string;
  externalProtocol?: typeof EXECUTOR_RESPONSE_PROTOCOL;
}

function normalizeOrigin(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error('execution.executor_response.origin_url must be an absolute HTTP(S) URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('execution.executor_response.origin_url must use http: or https:');
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(
      'execution.executor_response.origin_url must not contain credentials, query, or fragment'
    );
  }
  if (parsed.pathname !== '/' && parsed.pathname !== '') {
    throw new Error('execution.executor_response.origin_url must be an origin without a path');
  }
  return parsed.origin;
}

function resolveTimeoutByCommand(
  values: Record<string, number> | undefined
): Readonly<Record<string, number>> {
  if (values !== undefined && (!values || typeof values !== 'object' || Array.isArray(values))) {
    throw new Error(
      'Config error: execution.executor_response.timeout_ms.by_command must be a command-to-milliseconds mapping'
    );
  }
  const resolved: Record<string, number> = {};
  for (const [command, value] of Object.entries(values ?? {})) {
    if (!EXECUTOR_NAME_PATTERN.test(command)) {
      throw new Error(
        'Config error: execution.executor_response.timeout_ms.by_command keys must be executor command names containing only lowercase letters, numbers, periods, and hyphens'
      );
    }
    resolved[command] = resolveSafeIntegerInRange(value, {
      defaultValue: EXECUTOR_RESPONSE_DEFAULT_TIMEOUT_MS,
      minimum: EXECUTOR_RESPONSE_MIN_TIMEOUT_MS,
      maximum: EXECUTOR_RESPONSE_HARD_MAX_TIMEOUT_MS,
      path: `execution.executor_response.timeout_ms.by_command.${command}`,
    });
  }
  return Object.freeze(resolved);
}

export function resolveExecutorResponseConfig(
  raw?: AgorExecutorResponseSettings | null
): ResolvedExecutorResponseConfig {
  if (
    raw?.timeout_ms !== undefined &&
    (!raw.timeout_ms || typeof raw.timeout_ms !== 'object' || Array.isArray(raw.timeout_ms))
  ) {
    throw new Error('Config error: execution.executor_response.timeout_ms must be an object');
  }
  if (
    raw?.external_protocol !== undefined &&
    raw.external_protocol !== EXECUTOR_RESPONSE_PROTOCOL
  ) {
    throw new Error(
      `execution.executor_response.external_protocol must be '${EXECUTOR_RESPONSE_PROTOCOL}'`
    );
  }
  // Deliberately no external_protocol/origin_url pairing check here: this
  // parser also validates raw config.yaml, where a deployment may declare the
  // protocol while the replica-exact origin arrives only later via
  // AGOR_EXECUTOR_RESPONSE_ORIGIN_URL (one shared config.yaml, per-Pod env).
  // The pairing is enforced on the effective config by
  // assertValidEffectiveExecutionConfig, after environment projection.
  const originUrl = normalizeOrigin(raw?.origin_url);
  return {
    maxResponseBytes: resolveSafeIntegerInRange(raw?.max_response_bytes, {
      defaultValue: EXECUTOR_RESPONSE_DEFAULT_MAX_BYTES,
      minimum: EXECUTOR_RESPONSE_MIN_BYTES,
      maximum: EXECUTOR_RESPONSE_HARD_MAX_BYTES,
      path: 'execution.executor_response.max_response_bytes',
    }),
    maxActiveRequests: resolveSafeIntegerInRange(raw?.max_active_requests, {
      defaultValue: EXECUTOR_RESPONSE_DEFAULT_MAX_ACTIVE,
      minimum: 1,
      maximum: EXECUTOR_RESPONSE_HARD_MAX_ACTIVE,
      path: 'execution.executor_response.max_active_requests',
    }),
    defaultTimeoutMs: resolveSafeIntegerInRange(raw?.timeout_ms?.default, {
      defaultValue: EXECUTOR_RESPONSE_DEFAULT_TIMEOUT_MS,
      minimum: EXECUTOR_RESPONSE_MIN_TIMEOUT_MS,
      maximum: EXECUTOR_RESPONSE_HARD_MAX_TIMEOUT_MS,
      path: 'execution.executor_response.timeout_ms.default',
    }),
    timeoutByCommand: resolveTimeoutByCommand(raw?.timeout_ms?.by_command),
    ...(originUrl ? { originUrl } : {}),
    ...(raw?.external_protocol ? { externalProtocol: raw.external_protocol } : {}),
  };
}

/** Resolve one request timeout; operator command overrides beat call-specific defaults. */
export function resolveExecutorResponseTimeoutMs(
  config: ResolvedExecutorResponseConfig,
  command: string,
  callSpecificDefaultMs?: number
): number {
  return config.timeoutByCommand[command] ?? callSpecificDefaultMs ?? config.defaultTimeoutMs;
}
