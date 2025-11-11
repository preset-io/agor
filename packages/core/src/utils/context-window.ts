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
 * Normalize token usage from different agentic tools into a consistent format
 *
 * Different tools report tokens differently:
 * - **Codex/OpenAI**: input_tokens INCLUDES cached tokens (cache_read_tokens is a subset)
 * - **Claude**: input_tokens EXCLUDES cached tokens (cache_read_tokens is additional)
 * - **Gemini**: No caching, just input/output
 *
 * This function normalizes to a consistent model where:
 * - input_tokens = fresh (non-cached) input tokens only
 * - cache_read_tokens = cached tokens (if any)
 * - output_tokens = output tokens
 *
 * @param usage - Raw token usage from the SDK
 * @param agenticTool - The tool that generated this usage ('codex', 'claude-code', 'gemini', etc.)
 * @returns Normalized token usage where input_tokens always means fresh tokens
 */
export function normalizeTokenUsage(
  usage: TokenUsage | undefined,
  agenticTool?: string
): TokenUsage | undefined {
  if (!usage) return undefined;

  // For Codex/OpenAI: input_tokens includes cached tokens, so we need to subtract
  if (agenticTool === 'codex') {
    return {
      ...usage,
      // Fresh input = total input - cached portion
      input_tokens: (usage.input_tokens || 0) - (usage.cache_read_tokens || 0),
      // Keep cache_read_tokens as-is for reference
      cache_read_tokens: usage.cache_read_tokens,
      output_tokens: usage.output_tokens,
    };
  }

  // For Claude, Gemini, and others: input_tokens already represents fresh tokens
  return usage;
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
 * CORRECT FORMULA: input_tokens + cache_read_tokens
 *
 * Context window includes:
 * - input_tokens: Fresh input tokens (after cache breakpoints)
 * - cache_read_tokens: Cached content being read (FREE for billing, but IN the context!)
 *
 * EXCLUDES:
 * - cache_creation_tokens: Do NOT add these! They represent content being written to cache
 *   on THIS turn, which will appear as cache_read_tokens on FUTURE turns. Adding both would
 *   double-count the same content.
 * - output_tokens: Generated tokens, not part of input context
 *
 * @param usage - Token usage from a single task
 * @returns Context window usage in tokens, or undefined if no usage data
 */
export function calculateContextWindowUsage(usage: TokenUsage | undefined): number | undefined {
  if (!usage) return undefined;

  return (usage.input_tokens || 0) + (usage.cache_read_tokens || 0);
}

/**
 * Calculate context window usage from SDK model usage
 *
 * Same calculation as above, but for SDK's ModelUsage format.
 * Formula: inputTokens + cacheReadInputTokens (excludes cacheCreationInputTokens)
 *
 * @param modelUsage - Per-model usage from Agent SDK
 * @returns Context window usage in tokens
 */
export function calculateModelContextWindowUsage(modelUsage: ModelUsage): number {
  return (modelUsage.inputTokens || 0) + (modelUsage.cacheReadInputTokens || 0);
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

/**
 * Calculate cumulative context window usage across all tasks in a session
 *
 * This represents the ACTUAL conversation context size by summing input + output tokens
 * across all tasks, with proper handling for compaction events.
 *
 * Algorithm:
 * 1. Iterate through tasks in chronological order
 * 2. Normalize token usage based on agentic_tool (Codex reports differently than Claude)
 * 3. Sum (normalized_input_tokens + output_tokens) for each task
 * 4. When a compaction event is detected, reset the counter (context was trimmed)
 * 5. Return the cumulative sum
 *
 * Why input + output?
 * - input_tokens: User's prompt for this turn (fresh input, after normalization)
 * - output_tokens: Agent's response for this turn
 * - Together they represent the conversation tokens added in this turn
 * - Summing across turns gives total conversation size
 *
 * Note: This excludes system prompt, tool definitions, and context files which are
 * cached and not included in these token counts.
 *
 * @param tasks - All tasks in the session (ordered chronologically)
 * @param messages - All messages in the session (needed to detect compaction boundaries)
 * @param agenticTool - The agentic tool used ('codex', 'claude-code', 'gemini')
 * @returns Cumulative context window usage in tokens
 */
export function calculateCumulativeContextWindow(
  tasks: Array<{ usage?: TokenUsage; task_id: string }>,
  messages: Array<{ task_id?: string; type?: string; content?: unknown }>,
  agenticTool?: string
): number {
  // Find all compaction boundary messages (these mark where context was reset)
  const compactionTaskIds = new Set<string>();
  for (const msg of messages) {
    if (msg.type === 'system' && typeof msg.content === 'object' && msg.content !== null) {
      const content = msg.content as { type?: string; status?: string };
      // Check for compact_boundary or compacting status
      if (
        (Array.isArray(msg.content) &&
          msg.content.some(
            (block: { type?: string; status?: string }) =>
              block.type === 'system_status' && block.status === 'compacting'
          )) ||
        content.status === 'compacting'
      ) {
        // Only add task_id if it exists
        if (msg.task_id) {
          compactionTaskIds.add(msg.task_id);
        }
      }
    }
  }

  let cumulativeTokens = 0;
  let lastCompactionIndex = -1;

  // Find the most recent compaction event
  for (let i = tasks.length - 1; i >= 0; i--) {
    if (compactionTaskIds.has(tasks[i].task_id)) {
      lastCompactionIndex = i;
      break;
    }
  }

  // Sum tokens starting from after the last compaction (or from beginning if no compaction)
  const startIndex = lastCompactionIndex >= 0 ? lastCompactionIndex + 1 : 0;
  for (let i = startIndex; i < tasks.length; i++) {
    const task = tasks[i];
    if (task.usage) {
      // Normalize token usage based on agentic tool
      // This ensures consistent calculation regardless of how each tool reports tokens
      const normalized = normalizeTokenUsage(task.usage, agenticTool);
      if (normalized) {
        const turnTokens = (normalized.input_tokens || 0) + (normalized.output_tokens || 0);
        cumulativeTokens += turnTokens;
      }
    }
  }

  return cumulativeTokens;
}
