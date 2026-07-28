import type { SDKResultMessage } from '@agor/core/sdk';

const TOP_LEVEL_USAGE_COUNTERS = [
  'input_tokens',
  'output_tokens',
  'cache_creation_input_tokens',
  'cache_read_input_tokens',
] as const;

const MODEL_USAGE_COUNTERS = [
  'inputTokens',
  'outputTokens',
  'cacheReadInputTokens',
  'cacheCreationInputTokens',
  'webSearchRequests',
  'costUSD',
] as const;

/**
 * Aggregate per-turn Agent SDK results into the terminal result consumed by
 * ClaudeTool's task-level accounting. The individual results are still yielded
 * upstream; this makes the last one an authoritative query-level summary.
 */
export function aggregateClaudeResults(results: SDKResultMessage[]): SDKResultMessage {
  const terminal = results.at(-1);
  if (!terminal || results.length === 1) return terminal!;

  const usage = { ...terminal.usage };
  for (const key of TOP_LEVEL_USAGE_COUNTERS) {
    usage[key] = results.reduce((sum, result) => sum + (result.usage[key] ?? 0), 0);
  }

  const modelUsage: SDKResultMessage['modelUsage'] = {};
  for (const result of results) {
    for (const [modelId, current] of Object.entries(result.modelUsage)) {
      const aggregate = modelUsage[modelId]
        ? { ...modelUsage[modelId] }
        : {
            inputTokens: 0,
            outputTokens: 0,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            webSearchRequests: 0,
            costUSD: 0,
            contextWindow: 0,
            maxOutputTokens: 0,
          };
      for (const key of MODEL_USAGE_COUNTERS) {
        aggregate[key] += current[key] ?? 0;
      }
      aggregate.contextWindow = Math.max(aggregate.contextWindow, current.contextWindow ?? 0);
      aggregate.maxOutputTokens = Math.max(aggregate.maxOutputTokens, current.maxOutputTokens ?? 0);
      modelUsage[modelId] = aggregate;
    }
  }

  return {
    ...terminal,
    duration_ms: results.reduce((sum, result) => sum + result.duration_ms, 0),
    duration_api_ms: results.reduce((sum, result) => sum + result.duration_api_ms, 0),
    num_turns: results.reduce((sum, result) => sum + result.num_turns, 0),
    total_cost_usd: results.reduce((sum, result) => sum + result.total_cost_usd, 0),
    usage,
    modelUsage,
    permission_denials: results.flatMap((result) => result.permission_denials),
  };
}
