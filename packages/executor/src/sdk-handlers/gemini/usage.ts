import type { TokenUsage } from '../../types/token-usage.js';

function normalizeNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

/**
 * Normalize Gemini SDK usage payload into Agor's TokenUsage shape.
 *
 * Gemini emits Finished events with a usageMetadata block:
 * {
 *   promptTokenCount,
 *   candidatesTokenCount,
 *   totalTokenCount,
 *   cachedContentTokenCount? (if caching enabled)
 * }
 *
 * We map cachedContentTokenCount → cache_read_tokens so downstream utilities
 * (cost + context window) can treat Gemini like Claude/Codex.
 */
export function extractGeminiTokenUsage(raw: unknown): TokenUsage | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return undefined;
  }

  const payload = raw as Record<string, unknown>;
  const inputTokens = normalizeNumber(
    payload.promptTokenCount ?? payload.prompt_token_count ?? payload.input_tokens
  );
  const outputTokens = normalizeNumber(
    payload.candidatesTokenCount ?? payload.candidates_token_count ?? payload.output_tokens
  );
  const cacheReadTokens = normalizeNumber(
    payload.cachedContentTokenCount ??
      payload.cached_content_token_count ??
      payload.cache_read_tokens
  );
  const totalTokens = normalizeNumber(
    payload.totalTokenCount ??
      payload.total_token_count ??
      payload.total_tokens ??
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
