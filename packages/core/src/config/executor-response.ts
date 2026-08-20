import { EXECUTOR_RESPONSE_PROTOCOL } from '../executor-protocol';
import type { AgorExecutorResponseSettings } from './types';

export const EXECUTOR_RESPONSE_DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
export const EXECUTOR_RESPONSE_HARD_MAX_BYTES = 64 * 1024 * 1024;
export const EXECUTOR_RESPONSE_MIN_BYTES = 1024;
export const EXECUTOR_RESPONSE_DEFAULT_MAX_ACTIVE = 16;
export const EXECUTOR_RESPONSE_HARD_MAX_ACTIVE = 256;

export interface ResolvedExecutorResponseConfig {
  maxResponseBytes: number;
  maxActiveRequests: number;
  originUrl?: string;
  externalProtocol?: typeof EXECUTOR_RESPONSE_PROTOCOL;
}

function boundedPositiveInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  path: string
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw new Error(`${path} must be a safe integer between ${minimum} and ${maximum}`);
  }
  return resolved;
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

export function resolveExecutorResponseConfig(
  raw?: AgorExecutorResponseSettings | null
): ResolvedExecutorResponseConfig {
  if (
    raw?.external_protocol !== undefined &&
    raw.external_protocol !== EXECUTOR_RESPONSE_PROTOCOL
  ) {
    throw new Error(
      `execution.executor_response.external_protocol must be '${EXECUTOR_RESPONSE_PROTOCOL}'`
    );
  }
  const originUrl = normalizeOrigin(raw?.origin_url);
  if (raw?.external_protocol && !originUrl) {
    throw new Error('execution.executor_response.external_protocol requires an exact origin_url');
  }
  return {
    maxResponseBytes: boundedPositiveInteger(
      raw?.max_response_bytes,
      EXECUTOR_RESPONSE_DEFAULT_MAX_BYTES,
      EXECUTOR_RESPONSE_MIN_BYTES,
      EXECUTOR_RESPONSE_HARD_MAX_BYTES,
      'execution.executor_response.max_response_bytes'
    ),
    maxActiveRequests: boundedPositiveInteger(
      raw?.max_active_requests,
      EXECUTOR_RESPONSE_DEFAULT_MAX_ACTIVE,
      1,
      EXECUTOR_RESPONSE_HARD_MAX_ACTIVE,
      'execution.executor_response.max_active_requests'
    ),
    ...(originUrl ? { originUrl } : {}),
    ...(raw?.external_protocol ? { externalProtocol: raw.external_protocol } : {}),
  };
}
