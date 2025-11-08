/**
 * Context Window Utilities
 *
 * Helpers for calculating context window usage, excluding cache reads which are FREE.
 *
 * IMPORTANT: Prompt caching (cache_read_tokens) doesn't count against context window limits!
 * Only fresh input tokens, output tokens, and cache creation tokens count.
 */

/**
 * Token usage interface matching the Task.usage structure
 */
interface TokenUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_tokens?: number;
  cache_read_tokens?: number; // Not used in calculations (free!)
  total_tokens?: number;
  estimated_cost_usd?: number;
}

/**
 * Model usage interface from SDK (per-model breakdown)
 */
interface ModelUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number; // Not used in calculations (free!)
  contextWindow?: number;
}

/**
 * Calculate context window usage from token counts
 *
 * Context window usage = input_tokens + output_tokens + cache_creation_tokens
 *
 * NOTE: cache_read_tokens are FREE and don't count against the limit!
 * This is the whole point of prompt caching - cached reads are free.
 *
 * @param usage - Token usage object
 * @returns Context window usage (tokens that count toward limit)
 */
export function calculateContextWindowUsage(usage: TokenUsage | undefined): number | undefined {
  if (!usage) return undefined;

  return (
    (usage.input_tokens || 0) +
    (usage.output_tokens || 0) +
    (usage.cache_creation_tokens || 0)
  );
}

/**
 * Calculate context window usage from SDK model usage
 *
 * @param modelUsage - Per-model usage object from SDK
 * @returns Context window usage (tokens that count toward limit)
 */
export function calculateModelContextWindowUsage(modelUsage: ModelUsage): number {
  return (
    (modelUsage.inputTokens || 0) +
    (modelUsage.outputTokens || 0) +
    (modelUsage.cacheCreationInputTokens || 0)
  );
}
