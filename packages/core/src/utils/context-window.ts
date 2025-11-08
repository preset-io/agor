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
 *
 * NOTE: contextWindow is the model's MAXIMUM context window (the limit),
 * NOT the current usage. We must sum the token counts to get usage.
 */
interface ModelUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number; // Not used in calculations (free!)
  contextWindow?: number; // The model's LIMIT (e.g., 200k), NOT current usage
}

/**
 * Calculate context window usage from token counts
 *
 * Context window is the INPUT limit (how much context the model can see).
 * We use only input_tokens as this represents the fresh input sent to the model
 * after cache breakpoints.
 *
 * Context window usage = input_tokens
 *
 * NOTE: We do NOT include:
 * - output_tokens (separate limit)
 * - cache_creation_tokens (content being cached for next request)
 * - cache_read_tokens (free, doesn't count)
 *
 * @param usage - Token usage object
 * @returns Context window usage (input tokens that count toward limit)
 */
export function calculateContextWindowUsage(usage: TokenUsage | undefined): number | undefined {
  if (!usage) return undefined;

  return usage.input_tokens || 0;
}

/**
 * Calculate context window usage from SDK model usage
 *
 * Context window is the INPUT limit (how much context the model can see).
 * We use only inputTokens as this represents the fresh input sent to the model
 * after cache breakpoints.
 *
 * The SDK's `modelUsage.contextWindow` field is the model's LIMIT (e.g., 200k for Sonnet),
 * NOT the current usage.
 *
 * @param modelUsage - Per-model usage object from SDK
 * @returns Context window usage in tokens (inputTokens only)
 */
export function calculateModelContextWindowUsage(modelUsage: ModelUsage): number {
  return modelUsage.inputTokens || 0;
}
