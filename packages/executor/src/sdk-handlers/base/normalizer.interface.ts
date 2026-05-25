/**
 * SDK Response Normalizer Interface
 *
 * Each agentic tool implements this interface to transform its raw SDK response
 * into standardized derived values for consumption by UI, analytics, and other systems.
 *
 * Key principle: Normalizers are PURE FUNCTIONS - no mutations, no side effects.
 * They compute derived values on-demand from the raw SDK response.
 */

import type { ContextUsageSnapshot } from '@agor/core/types';

export interface NormalizedTokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export interface NormalizedSdkData {
  /**
   * Aggregated token usage (summed across all models if multi-model)
   */
  tokenUsage: NormalizedTokenUsage;

  /**
   * Context window limit (model's maximum capacity).
   * For multi-model: maximum limit across all models.
   *
   * When the executor captured an authoritative `contextUsageSnapshot`,
   * `base-executor` overwrites this field with the snapshot's `maxTokens`
   * so the limit matches what the agent itself reports.
   */
  contextWindowLimit: number;

  /**
   * Authoritative context-window snapshot from the agent, when available.
   *
   * Populated by `base-executor` from the tool's `rawContextUsage` (Claude:
   * SDK getContextUsage(); Codex: CLI event_msg/token_count.last_token_usage).
   * Consumers should prefer `contextUsageSnapshot.percentage` for display
   * over recomputing `totalTokens / maxTokens`, because tools may apply
   * non-trivial transformations (e.g. Codex subtracts a baseline overhead).
   */
  contextUsageSnapshot?: ContextUsageSnapshot;

  /**
   * Cost in USD (if available from SDK)
   * This is the actual cost reported by the SDK, not an estimate.
   */
  costUsd?: number;

  /**
   * Primary model used (e.g., "claude-sonnet-4-5-20250929")
   */
  primaryModel?: string;

  /**
   * Execution duration in milliseconds
   */
  durationMs?: number;
}

/**
 * Normalizer interface for agentic tool SDKs
 *
 * @template TRawSdkMessage - The SDK's raw result message type
 */
export interface INormalizer<TRawSdkMessage> {
  /**
   * Normalize raw SDK response into standardized format
   *
   * This is a pure function - no mutations, no side effects.
   * Computes derived values on-demand from the raw SDK response.
   *
   * @param raw - Raw SDK response message
   * @returns Normalized data with computed fields
   */
  normalize(raw: TRawSdkMessage): NormalizedSdkData;
}
