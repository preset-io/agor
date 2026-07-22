/**
 * Aggregate billable usage across the multiple SDK invocations a single task
 * can span when a rate-limited turn is auto-resumed.
 *
 * Each invocation returns its own result with its own usage / cost / duration.
 * Task accounting is driven off one `rawSdkResponse` (see base-executor), so
 * without aggregation only the last invocation's numbers would be billed and
 * the earlier (throttled) attempts' consumption would be dropped.
 *
 * Types are derived from the SDK result so no billable field is silently lost:
 * every additive count (tokens, per-model cost, web-search/web-fetch requests)
 * is summed; fixed-capacity fields (`contextWindow`, `maxOutputTokens`) take the
 * max; structural breakdowns we don't sum are preserved from the final result.
 */

import type { ModelUsage, SDKResultMessage } from '@agor/core/sdk';

/** The billable `usage` object carried on a Claude result (post-NonNullable). */
type ResultUsage = Extract<SDKResultMessage, { subtype: 'success' }>['usage'];
type ServerToolUsage = ResultUsage['server_tool_use'];

export interface RetryUsageAccumulator {
  /** Summed top-level token counts + server-tool requests. */
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
    server_tool_use: { web_fetch_requests: number; web_search_requests: number };
  };
  /** Per-model usage: additive fields summed, capacity fields maxed. */
  modelUsage: Record<string, ModelUsage>;
  totalCostUsd: number;
  durationMs: number;
  durationApiMs: number;
}

export function emptyRetryUsageAccumulator(): RetryUsageAccumulator {
  return {
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      server_tool_use: { web_fetch_requests: 0, web_search_requests: 0 },
    },
    modelUsage: {},
    totalCostUsd: 0,
    durationMs: 0,
    durationApiMs: 0,
  };
}

/**
 * Fold one invocation's result into the accumulator. Returns a new object.
 */
export function accumulateResultUsage(
  acc: RetryUsageAccumulator,
  raw: SDKResultMessage
): RetryUsageAccumulator {
  const usage = (raw as { usage?: Partial<ResultUsage> }).usage;
  const server = usage?.server_tool_use as ServerToolUsage | undefined;
  const next: RetryUsageAccumulator = {
    usage: {
      input_tokens: acc.usage.input_tokens + (usage?.input_tokens ?? 0),
      output_tokens: acc.usage.output_tokens + (usage?.output_tokens ?? 0),
      cache_creation_input_tokens:
        acc.usage.cache_creation_input_tokens + (usage?.cache_creation_input_tokens ?? 0),
      cache_read_input_tokens:
        acc.usage.cache_read_input_tokens + (usage?.cache_read_input_tokens ?? 0),
      server_tool_use: {
        web_fetch_requests:
          acc.usage.server_tool_use.web_fetch_requests + (server?.web_fetch_requests ?? 0),
        web_search_requests:
          acc.usage.server_tool_use.web_search_requests + (server?.web_search_requests ?? 0),
      },
    },
    modelUsage: structuredClone(acc.modelUsage),
    totalCostUsd: acc.totalCostUsd + ((raw as { total_cost_usd?: number }).total_cost_usd ?? 0),
    durationMs: acc.durationMs + ((raw as { duration_ms?: number }).duration_ms ?? 0),
    durationApiMs: acc.durationApiMs + ((raw as { duration_api_ms?: number }).duration_api_ms ?? 0),
  };

  const modelUsage = (raw as { modelUsage?: Record<string, Partial<ModelUsage>> }).modelUsage;
  if (modelUsage) {
    for (const [model, mu] of Object.entries(modelUsage)) {
      const prev = next.modelUsage[model];
      next.modelUsage[model] = {
        inputTokens: (prev?.inputTokens ?? 0) + (mu.inputTokens ?? 0),
        outputTokens: (prev?.outputTokens ?? 0) + (mu.outputTokens ?? 0),
        cacheReadInputTokens: (prev?.cacheReadInputTokens ?? 0) + (mu.cacheReadInputTokens ?? 0),
        cacheCreationInputTokens:
          (prev?.cacheCreationInputTokens ?? 0) + (mu.cacheCreationInputTokens ?? 0),
        webSearchRequests: (prev?.webSearchRequests ?? 0) + (mu.webSearchRequests ?? 0),
        costUSD: (prev?.costUSD ?? 0) + (mu.costUSD ?? 0),
        // Fixed capacities — take the max across invocations, never sum.
        contextWindow: Math.max(prev?.contextWindow ?? 0, mu.contextWindow ?? 0),
        maxOutputTokens: Math.max(prev?.maxOutputTokens ?? 0, mu.maxOutputTokens ?? 0),
      };
    }
  }

  return next;
}

/**
 * Produce the final result to report for task accounting: the eventual result's
 * identity (subtype, terminal_reason, errors, session_id, structural usage
 * breakdowns, …) with its billable usage / cost / duration replaced by the
 * aggregated totals. Structural fields we don't aggregate are preserved from the
 * final result rather than dropped.
 */
export function applyAccumulatedUsage(
  finalRaw: SDKResultMessage,
  acc: RetryUsageAccumulator
): SDKResultMessage {
  const finalUsage = (finalRaw as { usage?: ResultUsage }).usage;
  const mergedUsage = {
    ...(finalUsage ?? {}),
    input_tokens: acc.usage.input_tokens,
    output_tokens: acc.usage.output_tokens,
    cache_creation_input_tokens: acc.usage.cache_creation_input_tokens,
    cache_read_input_tokens: acc.usage.cache_read_input_tokens,
    server_tool_use: { ...(finalUsage?.server_tool_use ?? {}), ...acc.usage.server_tool_use },
  };
  return {
    ...finalRaw,
    usage: mergedUsage,
    ...(Object.keys(acc.modelUsage).length > 0 ? { modelUsage: acc.modelUsage } : {}),
    total_cost_usd: acc.totalCostUsd,
    duration_ms: acc.durationMs,
    duration_api_ms: acc.durationApiMs,
  } as SDKResultMessage;
}
