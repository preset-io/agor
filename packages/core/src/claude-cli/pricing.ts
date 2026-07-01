import type { AssistantUsage } from './event-types';

/**
 * Per-token pricing for Claude models, used by the CLI adapter to compute
 * cost from JSONL `usage` fields at `turn_end`.
 *
 * Numbers mirror Anthropic's public pricing page and the constants we
 * extracted from the `claude` binary itself (`Au$` table — same rates the
 * REPL's `/usage` command displays). Units are USD per **token** (the
 * public table is "per 1M tokens"; we divide by 1e6 below at the call
 * site to keep these constants legible).
 *
 * Why hand-roll vs `ccusage`:
 *   - v1 ships without a network/dependency hop for cost math.
 *   - The set of models that flow through the CLI adapter is small and
 *     bounded by what Anthropic exposes via `claude --model <X>`.
 *   - Flipping to ccusage (which fetches prices from LiteLLM) is queued
 *     and covered in docs/internal/claude-code-cli-integration-analysis-2026-05-14.md.
 *
 * If a model is missing from this table, callers should treat the
 * resulting `costUsd` as `undefined` rather than zero — `getModelPricing`
 * returns null in that case.
 */

export interface ClaudeModelPricing {
  /** USD per 1M input tokens (non-cached). */
  inputPerMTok: number;
  /** USD per 1M output tokens. */
  outputPerMTok: number;
  /** USD per 1M cache-creation (write) tokens, 5m ephemeral tier. */
  cacheWritePerMTok: number;
  /** USD per 1M cache-read tokens. */
  cacheReadPerMTok: number;
  /** USD per web-search request (server-side tool). */
  webSearchPerRequest?: number;
}

/**
 * Per-model pricing. Keys are the model-id prefix `getModelPricing()` matches
 * against (longest-prefix wins) — so `claude-opus-4-7` matches the `claude-opus-4`
 * entry even if Anthropic mints a `-7-1` patch revision.
 */
const PRICING: ReadonlyArray<{ prefix: string; price: ClaudeModelPricing }> = [
  // Sonnet 5 introductory pricing through 2026-08-31.
  {
    prefix: 'claude-sonnet-5',
    price: {
      inputPerMTok: 2,
      outputPerMTok: 10,
      cacheWritePerMTok: 2.5,
      cacheReadPerMTok: 0.2,
      webSearchPerRequest: 0.01,
    },
  },
  // Opus 4.x — most expensive tier.
  {
    prefix: 'claude-opus-4',
    price: {
      inputPerMTok: 15,
      outputPerMTok: 75,
      cacheWritePerMTok: 18.75,
      cacheReadPerMTok: 1.5,
      webSearchPerRequest: 0.01,
    },
  },
  // Sonnet 4.x — workhorse default.
  {
    prefix: 'claude-sonnet-4',
    price: {
      inputPerMTok: 3,
      outputPerMTok: 15,
      cacheWritePerMTok: 3.75,
      cacheReadPerMTok: 0.3,
      webSearchPerRequest: 0.01,
    },
  },
  // Haiku 4.x.
  {
    prefix: 'claude-haiku-4',
    price: {
      inputPerMTok: 0.8,
      outputPerMTok: 4,
      cacheWritePerMTok: 1,
      cacheReadPerMTok: 0.08,
      webSearchPerRequest: 0.01,
    },
  },
  // 3.7 / 3.5 family — kept around for resume-old-sessions cases.
  {
    prefix: 'claude-3-7-sonnet',
    price: {
      inputPerMTok: 3,
      outputPerMTok: 15,
      cacheWritePerMTok: 3.75,
      cacheReadPerMTok: 0.3,
    },
  },
  {
    prefix: 'claude-3-5-sonnet',
    price: {
      inputPerMTok: 3,
      outputPerMTok: 15,
      cacheWritePerMTok: 3.75,
      cacheReadPerMTok: 0.3,
    },
  },
  {
    prefix: 'claude-3-5-haiku',
    price: {
      inputPerMTok: 0.8,
      outputPerMTok: 4,
      cacheWritePerMTok: 1,
      cacheReadPerMTok: 0.08,
    },
  },
];

/**
 * Resolve pricing for a model id. Longest-prefix match against the table
 * above so versioned suffixes don't break us (e.g. `claude-opus-4-7-20260101`
 * still hits the `claude-opus-4` entry).
 *
 * Returns `null` for unknown models — caller treats that as "cost unknown"
 * rather than zero.
 */
export function getModelPricing(modelId: string | null | undefined): ClaudeModelPricing | null {
  if (!modelId) return null;
  let best: { prefix: string; price: ClaudeModelPricing } | null = null;
  for (const entry of PRICING) {
    if (modelId.startsWith(entry.prefix)) {
      if (!best || entry.prefix.length > best.prefix.length) {
        best = entry;
      }
    }
  }
  return best?.price ?? null;
}

/**
 * Compute total cost in USD for one assistant turn's usage.
 *
 * Mirrors the math we extracted from the `claude` binary:
 *   inputTokens × input + outputTokens × output
 *   + cache_creation × cacheWrite
 *   + cache_read × cacheRead
 *   + web_search_requests × webSearch
 *
 * Returns `undefined` when pricing is unknown — never returns 0 as a
 * "missing data" signal because legitimate small turns can cost ~$0.
 *
 * The `usage` parameter is the JSONL transcript's `assistant.message.usage`
 * shape — `AssistantUsage` from `./event-types`.
 */
export function computeCost(
  modelId: string | null | undefined,
  usage: AssistantUsage | null | undefined
): number | undefined {
  const price = getModelPricing(modelId);
  if (!price || !usage) return undefined;
  const M = 1_000_000;
  const inputCost = ((usage.input_tokens ?? 0) * price.inputPerMTok) / M;
  const outputCost = ((usage.output_tokens ?? 0) * price.outputPerMTok) / M;
  const cacheWriteCost = ((usage.cache_creation_input_tokens ?? 0) * price.cacheWritePerMTok) / M;
  const cacheReadCost = ((usage.cache_read_input_tokens ?? 0) * price.cacheReadPerMTok) / M;
  const webSearchCost = price.webSearchPerRequest
    ? (usage.server_tool_use?.web_search_requests ?? 0) * price.webSearchPerRequest
    : 0;
  return inputCost + outputCost + cacheWriteCost + cacheReadCost + webSearchCost;
}

/**
 * Model context-window capacity in tokens. Used to compute "% of context
 * consumed" for the session-detail UI. Same prefix-match strategy as
 * `getModelPricing`.
 */
export function getContextWindowLimit(modelId: string | null | undefined): number {
  if (!modelId) return 200_000;
  // 1M context beta — encoded as a model-id suffix in Agor; bare `claude-*`
  // ids without the `[1m]` suffix get the standard 200K window.
  if (modelId.includes('[1m]') || modelId.endsWith('-1m')) return 1_000_000;
  return 200_000;
}
