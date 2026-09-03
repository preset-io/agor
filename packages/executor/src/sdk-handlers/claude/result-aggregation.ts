import type { SDKResultMessage } from '@agor/core/sdk';

const TOP_LEVEL_USAGE_COUNTERS = [
  'input_tokens',
  'output_tokens',
  'cache_creation_input_tokens',
  'cache_read_input_tokens',
] as const;

/**
 * Aggregate per-turn Agent SDK results into the terminal result consumed by
 * ClaudeTool's task-level accounting. `usage`, durations, turns, and permission
 * denials are per-turn, so they are summed. `modelUsage` and `total_cost_usd`
 * are cumulative across a streaming-input query as of Agent SDK 0.3.223, so
 * the terminal result is already authoritative and must not be summed again.
 * The individual results are still yielded upstream.
 */
export function aggregateClaudeResults(results: SDKResultMessage[]): SDKResultMessage {
  const terminal = results.at(-1);
  if (!terminal || results.length === 1) return terminal!;

  const usage = { ...terminal.usage };
  for (const key of TOP_LEVEL_USAGE_COUNTERS) {
    usage[key] = results.reduce((sum, result) => sum + (result.usage[key] ?? 0), 0);
  }

  return {
    ...terminal,
    duration_ms: results.reduce((sum, result) => sum + result.duration_ms, 0),
    duration_api_ms: results.reduce((sum, result) => sum + result.duration_api_ms, 0),
    num_turns: results.reduce((sum, result) => sum + result.num_turns, 0),
    usage,
    permission_denials: results.flatMap((result) => result.permission_denials),
  };
}
