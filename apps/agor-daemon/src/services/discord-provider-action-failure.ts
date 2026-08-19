import { boundedBackoffDelay } from '@agor/core/coordination';
import {
  DiscordDeliveryCoordinateError,
  DiscordNonceRecoveryIncompleteError,
} from '@agor/core/gateway';
import type { GatewayProviderActionExecutionResult } from './gateway-provider-action-processor.js';

const MAX_RETRY_AFTER_MS = 24 * 60 * 60_000;

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
}

function numeric(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function statusCode(error: unknown): number | undefined {
  const outer = record(error);
  const raw = record(outer?.rawError);
  return numeric(outer?.status) ?? numeric(raw?.status);
}

function discordCode(error: unknown): string | undefined {
  const outer = record(error);
  const raw = record(outer?.rawError);
  const value = raw?.code ?? outer?.code;
  return typeof value === 'string' || typeof value === 'number' ? String(value) : undefined;
}

/** Discord delete is idempotent: an unknown-message/404 cleanup is complete. */
export function isDiscordUnknownMessageError(error: unknown): boolean {
  return statusCode(error) === 404 || discordCode(error) === '10008';
}

function retryAfterMs(error: unknown): number | undefined {
  const outer = record(error);
  const raw = record(outer?.rawError);
  // @discordjs/rest RateLimitError.retryAfter is documented in milliseconds.
  const libraryDelay = numeric(outer?.retryAfter);
  // Discord JSON error bodies expose retry_after in seconds.
  const responseDelay = numeric(raw?.retry_after) ?? numeric(outer?.retry_after);
  const value = libraryDelay ?? (responseDelay === undefined ? undefined : responseDelay * 1_000);
  if (value === undefined) return undefined;
  return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, Math.ceil(value)));
}

/** Content-free retry/dead-letter classification for Discord REST failures. */
export function classifyDiscordProviderActionFailure(
  error: unknown,
  attempt: number,
  random = Math.random()
): Exclude<
  GatewayProviderActionExecutionResult,
  { outcome: 'complete' | 'owner_lost' | 'claim_lost' | 'already_transitioned' }
> {
  if (
    error instanceof DiscordNonceRecoveryIncompleteError ||
    (error instanceof Error && error.name === 'DiscordNonceRecoveryIncompleteError')
  ) {
    return { outcome: 'dead_letter', errorCode: 'discord_nonce_recovery_incomplete' };
  }
  if (
    error instanceof DiscordDeliveryCoordinateError ||
    (error instanceof Error && error.name === 'DiscordDeliveryCoordinateError')
  ) {
    return { outcome: 'dead_letter', errorCode: 'discord_delivery_coordinate_conflict' };
  }
  const status = statusCode(error);
  const code = discordCode(error);
  const rateLimitDelay = retryAfterMs(error);
  if (status === 429 || rateLimitDelay !== undefined) {
    return {
      outcome: 'retry',
      errorCode: 'discord_rate_limited',
      retryAfterMs: rateLimitDelay ?? 1_000,
    };
  }
  if (status === 401 || code === '40001' || code === '40002') {
    return { outcome: 'dead_letter', errorCode: 'discord_auth_rejected' };
  }
  if (status === 403 || code === '50013' || code === '50001') {
    return { outcome: 'dead_letter', errorCode: 'discord_permission_rejected' };
  }
  if (
    status === 400 ||
    status === 404 ||
    code === '10003' ||
    code === '10008' ||
    code === '50035'
  ) {
    return { outcome: 'dead_letter', errorCode: 'discord_content_or_target_rejected' };
  }
  const retryMs = boundedBackoffDelay(
    Math.max(1, attempt),
    { baseDelayMs: 1_000, maxDelayMs: 5 * 60_000, jitterRatio: 0.2 },
    random
  );
  return {
    outcome: 'retry',
    errorCode: status && status >= 500 ? 'discord_server_error' : 'discord_transport_error',
    retryAfterMs: retryMs,
  };
}
