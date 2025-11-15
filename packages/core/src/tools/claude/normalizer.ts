/**
 * Claude Code SDK Response Normalizer
 *
 * Transforms Claude Agent SDK's raw SDKResultMessage into standardized format.
 *
 * Key responsibilities:
 * - Sum tokens across all models (Haiku, Sonnet, etc.) for multi-model sessions
 * - Calculate context window usage from model usage data
 * - Extract primary model and costs
 */

import type { SDKResultMessage } from '@anthropic-ai/claude-agent-sdk/sdk';
import type { INormalizer, NormalizedSdkData } from '../base/normalizer.interface';

export class ClaudeCodeNormalizer implements INormalizer<SDKResultMessage> {
  normalize(msg: SDKResultMessage): NormalizedSdkData {
    // Extract basic metadata
    const durationMs = msg.duration_ms;
    const estimatedCostUsd = msg.total_cost_usd;

    // If modelUsage exists, aggregate across all models
    if (msg.modelUsage && typeof msg.modelUsage === 'object') {
      return this.normalizeMultiModel(msg.modelUsage, durationMs, estimatedCostUsd);
    }

    // Fallback to top-level usage (older SDK versions or single-model)
    if (msg.usage) {
      return this.normalizeSingleModel(msg.usage, durationMs, estimatedCostUsd);
    }

    // No usage data available - return zeros
    return {
      tokenUsage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      },
      contextWindow: 0,
      contextWindowLimit: 0,
      durationMs,
      estimatedCostUsd,
    };
  }

  /**
   * Normalize multi-model usage (Haiku + Sonnet, etc.)
   * Sums tokens across all models
   */
  private normalizeMultiModel(
    modelUsage: Record<string, any>,
    durationMs?: number,
    estimatedCostUsd?: number
  ): NormalizedSdkData {
    let totalInput = 0;
    let totalOutput = 0;
    let totalCacheRead = 0;
    let totalCacheCreation = 0;
    let maxLimit = 0;
    let primaryModel: string | undefined;

    // Iterate through all models and sum tokens
    for (const [modelId, usage] of Object.entries(modelUsage)) {
      const inputTokens = usage.inputTokens || 0;
      const outputTokens = usage.outputTokens || 0;
      const cacheReadTokens = usage.cacheReadInputTokens || 0;
      const cacheCreationTokens = usage.cacheCreationInputTokens || 0;
      const contextWindowLimit = usage.contextWindow || 0;

      totalInput += inputTokens;
      totalOutput += outputTokens;
      totalCacheRead += cacheReadTokens;
      totalCacheCreation += cacheCreationTokens;

      // Track max context window limit
      if (contextWindowLimit > maxLimit) {
        maxLimit = contextWindowLimit;
        primaryModel = modelId; // Model with largest context window is primary
      }
    }

    return {
      tokenUsage: {
        inputTokens: totalInput,
        outputTokens: totalOutput,
        totalTokens: totalInput + totalOutput,
        cacheReadTokens: totalCacheRead,
        cacheCreationTokens: totalCacheCreation,
      },
      // Context window = input + cache_read (NOT cache_creation)
      // cache_creation tokens will appear as cache_read in future turns
      contextWindow: totalInput + totalCacheRead,
      contextWindowLimit: maxLimit,
      primaryModel,
      durationMs,
      estimatedCostUsd,
    };
  }

  /**
   * Normalize single-model usage (fallback for older SDK versions)
   */
  private normalizeSingleModel(
    usage: any,
    durationMs?: number,
    estimatedCostUsd?: number
  ): NormalizedSdkData {
    const inputTokens = usage.input_tokens || 0;
    const outputTokens = usage.output_tokens || 0;
    const cacheReadTokens = usage.cache_read_input_tokens || 0;
    const cacheCreationTokens = usage.cache_creation_input_tokens || 0;

    return {
      tokenUsage: {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        cacheReadTokens,
        cacheCreationTokens,
      },
      // Context window = input + cache_read (NOT cache_creation)
      contextWindow: inputTokens + cacheReadTokens,
      // Default to 200K for Claude models (standard context window)
      contextWindowLimit: 200000,
      durationMs,
      estimatedCostUsd,
    };
  }
}
