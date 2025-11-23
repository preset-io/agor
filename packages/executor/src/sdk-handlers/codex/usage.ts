import type { TokenUsage } from '../../types/token-usage.js';

function normalizeNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
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
