/**
 * Context Window Utilities
 *
 * Calculates context window usage based on the Anthropic API's cumulative token reporting.
 *
 * CRITICAL INSIGHTS:
 *
 * 1. From https://codelynx.dev/posts/calculate-claude-code-context:
 *    "The Anthropic API returns cumulative token usage. Each API response includes
 *    the total tokens used in that conversation turn—you don't need to sum them up."
 *
 * 2. From https://docs.claude.com/en/docs/build-with-claude/prompt-caching:
 *    cache_read_tokens are FREE for billing (90% discount) but DO count toward context window!
 *
 * 3. IMPORTANT: cache_creation_tokens should NOT be added to context calculation because:
 *    - When content is cached (cache_creation_tokens), it's part of the current turn's input
 *    - On FUTURE turns, that cached content appears in cache_read_tokens
 *    - Adding both would DOUBLE-COUNT the same content!
 *
 * CORRECT FORMULA:
 * context_window_usage = input_tokens + cache_read_tokens
 *
 * This means:
 * - Each task's usage already contains CUMULATIVE context from all previous turns
 * - We only need the LATEST task's token counts
 * - We do NOT sum across tasks (that would double-count)
 * - We do NOT include cache_creation_tokens (already counted in future cache_read_tokens)
 *
 * References:
 * - https://codelynx.dev/posts/calculate-claude-code-context
 * - https://docs.claude.com/en/docs/build-with-claude/prompt-caching
 * - https://code.claude.com/docs/en/monitoring-usage
 */

// No imports needed - legacy token accounting utilities only

/**
 * Token usage interface matching the Task.usage structure
 */
interface TokenUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_tokens?: number;
  cache_read_tokens?: number;
  total_tokens?: number;
  estimated_cost_usd?: number;
}

// DEAD CODE REMOVED: normalizeTokenUsage
// Use normalizeRawSdkResponse() from utils/sdk-normalizer instead

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
  cacheReadInputTokens?: number;
  contextWindow?: number; // The model's LIMIT (e.g., 200K), NOT current usage
}

// DEAD CODE REMOVED: calculateContextWindowUsage
// Use normalizeRawSdkResponse() from utils/sdk-normalizer instead

// DEAD CODE REMOVED: calculateModelContextWindowUsage
// Use ClaudeCodeNormalizer.normalizeMultiModel() instead - it handles the entire aggregation

// Dead code removed - token accounting now handled via normalizeRawSdkResponse()
// in utils/sdk-normalizer.ts. UI components call normalizeRawSdkResponse() directly.
