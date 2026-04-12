import type { TokenUsage } from '../../types/token-usage.js';

function normalizeNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function sanitizeTokenCount(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  return Math.max(0, value);
}

/**
 * Normalize Codex SDK usage payload into Agor's TokenUsage shape.
 *
 * Codex emits turn.completed events with a usage block:
 * {
 *   input_tokens,
 *   output_tokens,
 *   cached_input_tokens
 * }
 *
 * We map cached_input_tokens → cache_read_tokens so downstream utilities
 * (cost + context window) can treat Codex like Claude/Gemini.
 */
export function extractCodexTokenUsage(raw: unknown): TokenUsage | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return undefined;
  }

  const payload = raw as Record<string, unknown>;
  const inputTokens = normalizeNumber(payload.input_tokens ?? payload.inputTokens);
  const outputTokens = normalizeNumber(payload.output_tokens ?? payload.outputTokens);
  const cacheReadTokens = normalizeNumber(
    payload.cached_input_tokens ?? payload.cachedInputTokens ?? payload.cache_read_tokens
  );
  const totalTokens = normalizeNumber(
    payload.total_tokens ??
      payload.totalTokens ??
      (inputTokens !== undefined || outputTokens !== undefined
        ? (inputTokens || 0) + (outputTokens || 0)
        : undefined)
  );

  const usage: TokenUsage = {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_read_tokens: cacheReadTokens,
    total_tokens: totalTokens,
  };

  if (
    usage.input_tokens === undefined &&
    usage.output_tokens === undefined &&
    usage.cache_read_tokens === undefined &&
    usage.total_tokens === undefined
  ) {
    return undefined;
  }

  return usage;
}

/**
 * Extract context-window usage from a Codex turn payload.
 *
 * Source semantics from @openai/codex-sdk:
 * - `usage.input_tokens` and `usage.cached_input_tokens` are input-side tokens used DURING the turn.
 * - `usage.output_tokens` are completion tokens and should not count toward context-window occupancy.
 *
 * Returns the best available approximation for current context occupancy:
 * 1) input + cached_input (preferred)
 * 2) total_tokens (legacy fallback when input fields are missing)
 * 3) undefined (no usable data)
 */
export function extractCodexContextWindowUsage(raw: unknown): number | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return undefined;
  }

  const payload = raw as Record<string, unknown>;
  const usage =
    payload.usage && typeof payload.usage === 'object' && !Array.isArray(payload.usage)
      ? (payload.usage as Record<string, unknown>)
      : payload;

  const inputTokens = sanitizeTokenCount(
    normalizeNumber(usage.input_tokens ?? usage.inputTokens ?? usage.prompt_tokens)
  );
  const cachedInputTokens = sanitizeTokenCount(
    normalizeNumber(usage.cached_input_tokens ?? usage.cachedInputTokens ?? usage.cache_read_tokens)
  );

  if (inputTokens !== undefined || cachedInputTokens !== undefined) {
    return (inputTokens || 0) + (cachedInputTokens || 0);
  }

  const fallbackTotal = sanitizeTokenCount(
    normalizeNumber(usage.total_tokens ?? usage.totalTokens)
  );
  return fallbackTotal;
}

/**
 * Extract an authoritative context snapshot from Codex `event_msg` token_count payloads.
 *
 * Expected shape (from Codex CLI protocol):
 * {
 *   type: "event_msg",
 *   payload: {
 *     type: "token_count",
 *     info: {
 *       total_token_usage: { total_tokens: number, ... },
 *       model_context_window: number
 *     }
 *   }
 * }
 */
export function extractCodexContextSnapshotFromEvent(
  raw: unknown
): { totalTokens: number; maxTokens: number; percentage: number } | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return undefined;
  }

  const event = raw as Record<string, unknown>;
  if (event.type !== 'event_msg') {
    return undefined;
  }

  const payload =
    event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload)
      ? (event.payload as Record<string, unknown>)
      : undefined;
  if (!payload || payload.type !== 'token_count') {
    return undefined;
  }

  const info =
    payload.info && typeof payload.info === 'object' && !Array.isArray(payload.info)
      ? (payload.info as Record<string, unknown>)
      : undefined;
  if (!info) {
    return undefined;
  }

  const totalUsage =
    info.total_token_usage &&
    typeof info.total_token_usage === 'object' &&
    !Array.isArray(info.total_token_usage)
      ? (info.total_token_usage as Record<string, unknown>)
      : undefined;

  const totalTokens = sanitizeTokenCount(
    normalizeNumber(totalUsage?.total_tokens ?? totalUsage?.totalTokens)
  );
  const maxTokens = sanitizeTokenCount(
    normalizeNumber(info.model_context_window ?? info.modelContextWindow)
  );

  if (totalTokens === undefined || maxTokens === undefined || maxTokens <= 0) {
    return undefined;
  }

  const percentage = Math.max(0, Math.min(100, Math.round((totalTokens / maxTokens) * 100)));
  return {
    totalTokens,
    maxTokens,
    percentage,
  };
}
