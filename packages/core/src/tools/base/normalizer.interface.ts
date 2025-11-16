/**
 * SDK Response Normalizer Interface
 *
 * Each agentic tool implements this interface to transform its raw SDK response
 * into standardized derived values for consumption by UI, analytics, and other systems.
 *
 * Key principle: Normalizers are PURE FUNCTIONS - no mutations, no side effects.
 * They compute derived values on-demand from the raw SDK response.
 */

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
   * Context window limit (model's maximum capacity)
   * For multi-model: maximum limit across all models
   *
   * Note: Context window USAGE is tracked separately via Task.computed_context_window
   * which is populated by tool.computeContextWindow(). This avoids confusion between
   * per-task tokens (in tokenUsage) vs cumulative session tokens (in computed_context_window).
   */
  contextWindowLimit: number;

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
