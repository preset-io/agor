/**
 * Context Window Utilities
 *
 * Calculates context window usage based on the Anthropic API's cumulative token reporting.
 *
 * CRITICAL INSIGHT from https://codelynx.dev/posts/calculate-claude-code-context:
 * "Because the Anthropic API returns cumulative token usage. Each API response includes
 * the total tokens used in that conversation turn—you don't need to sum them up."
 *
 * This means:
 * - Each task's usage already contains the CUMULATIVE context from all previous turns
 * - We only need the LATEST task's token counts
 * - We do NOT sum across tasks (that would double-count cached content)
 *
 * Context window calculation:
 * input_tokens + cache_read_tokens + cache_creation_tokens
 *
 * NOTE: cache_read_tokens are FREE for billing but DO count toward context window!
 * Reference: https://codelynx.dev/posts/calculate-claude-code-context
 */

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

/**
 * Calculate context window usage from a single task's token counts
 *
 * Context window includes ALL tokens in the conversation context:
 * - input_tokens: Fresh input after cache breakpoints
 * - cache_read_tokens: Content read from cache (FREE for billing, but IN the context!)
 * - cache_creation_tokens: Content being cached (in the context!)
 *
 * Note: output_tokens are NOT included (those are generated tokens, separate from input context)
 *
 * Reference: https://codelynx.dev/posts/calculate-claude-code-context
 *
 * @param usage - Token usage from a single task
 * @returns Context window usage in tokens, or undefined if no usage data
 */
export function calculateContextWindowUsage(usage: TokenUsage | undefined): number | undefined {
  if (!usage) return undefined;

  return (
    (usage.input_tokens || 0) + (usage.cache_read_tokens || 0) + (usage.cache_creation_tokens || 0)
  );
}

/**
 * Calculate context window usage from SDK model usage
 *
 * Same calculation as above, but for SDK's ModelUsage format.
 *
 * @param modelUsage - Per-model usage from Agent SDK
 * @returns Context window usage in tokens
 */
export function calculateModelContextWindowUsage(modelUsage: ModelUsage): number {
  return (
    (modelUsage.inputTokens || 0) +
    (modelUsage.cacheReadInputTokens || 0) +
    (modelUsage.cacheCreationInputTokens || 0)
  );
}

/**
 * Get session-level context window usage
 *
 * Algorithm (from https://codelynx.dev/posts/calculate-claude-code-context):
 * 1. Find the most recent task with valid usage data
 * 2. Extract: input_tokens + cache_read_tokens + cache_creation_tokens
 * 3. That's the session's current context (cumulative)
 *
 * We do NOT sum across tasks because each task already contains cumulative totals
 * from the Anthropic API.
 *
 * @param tasks - All tasks in the session (should be ordered by creation time)
 * @returns Current context window usage, or undefined if no tasks have usage data
 */
export function getSessionContextUsage(tasks: Array<{ usage?: TokenUsage }>): number | undefined {
  // Find the most recent task with usage data
  for (let i = tasks.length - 1; i >= 0; i--) {
    const task = tasks[i];
    if (task.usage) {
      return calculateContextWindowUsage(task.usage);
    }
  }
  return undefined;
}

/**
 * Get context window limit from tasks
 *
 * Searches tasks in reverse order to find the most recent context_window_limit value.
 *
 * @param tasks - All tasks in the session
 * @returns Context window limit (e.g., 200000 for Sonnet), or undefined if not found
 */
export function getContextWindowLimit(
  tasks: Array<{ context_window_limit?: number }>
): number | undefined {
  for (let i = tasks.length - 1; i >= 0; i--) {
    const limit = tasks[i].context_window_limit;
    if (limit) {
      return limit;
    }
  }
  return undefined;
}
