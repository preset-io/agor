/**
 * Aggregate billable usage across the multiple SDK invocations a single task
 * can span when a rate-limited turn is auto-resumed.
 *
 * Each invocation returns its own result with its own usage / cost / duration.
 * Task accounting is driven off one `rawSdkResponse` (see base-executor), so
 * without aggregation only the last invocation's numbers would be billed and
 * the earlier (throttled) attempts' consumption would be dropped.
 */

import type { SDKResultMessage } from '@agor/core/sdk';
import type { ClaudeModelUsage } from '../../types/sdk-response.js';

interface TopLevelUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export interface RetryUsageAccumulator {
  usage: Required<TopLevelUsage>;
  modelUsage: Record<string, ClaudeModelUsage>;
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
    },
    modelUsage: {},
    totalCostUsd: 0,
    durationMs: 0,
    durationApiMs: 0,
  };
}

type RawResult = SDKResultMessage & {
  usage?: TopLevelUsage;
  modelUsage?: Record<string, ClaudeModelUsage>;
  total_cost_usd?: number;
  duration_ms?: number;
  duration_api_ms?: number;
};

/**
 * Fold one invocation's result into the accumulator. Token counts, cost and
 * duration are summed; per-model `contextWindow` is a fixed window size, so the
 * largest reported value wins rather than being summed. Returns a new object.
 */
export function accumulateResultUsage(
  acc: RetryUsageAccumulator,
  raw: RawResult
): RetryUsageAccumulator {
  const next: RetryUsageAccumulator = {
    usage: { ...acc.usage },
    modelUsage: structuredClone(acc.modelUsage),
    totalCostUsd: acc.totalCostUsd + (raw.total_cost_usd ?? 0),
    durationMs: acc.durationMs + (raw.duration_ms ?? 0),
    durationApiMs: acc.durationApiMs + (raw.duration_api_ms ?? 0),
  };

  const u = raw.usage;
  if (u) {
    next.usage.input_tokens += u.input_tokens ?? 0;
    next.usage.output_tokens += u.output_tokens ?? 0;
    next.usage.cache_creation_input_tokens += u.cache_creation_input_tokens ?? 0;
    next.usage.cache_read_input_tokens += u.cache_read_input_tokens ?? 0;
  }

  if (raw.modelUsage) {
    for (const [model, mu] of Object.entries(raw.modelUsage)) {
      const prev = next.modelUsage[model] ?? {};
      next.modelUsage[model] = {
        inputTokens: (prev.inputTokens ?? 0) + (mu.inputTokens ?? 0),
        outputTokens: (prev.outputTokens ?? 0) + (mu.outputTokens ?? 0),
        cacheReadInputTokens: (prev.cacheReadInputTokens ?? 0) + (mu.cacheReadInputTokens ?? 0),
        cacheCreationInputTokens:
          (prev.cacheCreationInputTokens ?? 0) + (mu.cacheCreationInputTokens ?? 0),
        contextWindow: Math.max(prev.contextWindow ?? 0, mu.contextWindow ?? 0) || undefined,
      };
    }
  }

  return next;
}

/**
 * Produce the final result to report for task accounting: the eventual result's
 * identity (subtype, terminal_reason, errors, session_id, …) with its billable
 * usage / cost / duration replaced by the aggregated totals.
 */
export function applyAccumulatedUsage(
  finalRaw: SDKResultMessage,
  acc: RetryUsageAccumulator
): SDKResultMessage {
  const raw = finalRaw as RawResult;
  return {
    ...finalRaw,
    usage: { ...(raw.usage ?? {}), ...acc.usage },
    ...(Object.keys(acc.modelUsage).length > 0 ? { modelUsage: acc.modelUsage } : {}),
    total_cost_usd: acc.totalCostUsd,
    duration_ms: acc.durationMs,
    duration_api_ms: acc.durationApiMs,
  } as SDKResultMessage;
}
