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
    const costUsd = msg.total_cost_usd;

    // If modelUsage exists, aggregate across all models
    if (msg.modelUsage && typeof msg.modelUsage === 'object') {
      return this.normalizeMultiModel(msg.modelUsage, durationMs, costUsd);
    }

    // Fallback to top-level usage (older SDK versions or single-model)
    if (msg.usage) {
      return this.normalizeSingleModel(msg.usage, durationMs, costUsd);
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
      costUsd,
    };
  }

  /**
   * Normalize multi-model usage (Haiku + Sonnet, etc.)
   * Sums tokens across all models
   */
  private normalizeMultiModel(
    modelUsage: Record<string, unknown>,
    durationMs?: number,
    costUsd?: number
  ): NormalizedSdkData {
    let totalInput = 0;
    let totalOutput = 0;
    let totalCacheRead = 0;
    let totalCacheCreation = 0;
    let maxLimit = 0;
    let primaryModel: string | undefined;

    // Iterate through all models and sum tokens
    for (const [modelId, usage] of Object.entries(modelUsage)) {
      // biome-ignore lint/suspicious/noExplicitAny: SDK modelUsage has dynamic structure
      const usageData = usage as any;
      const inputTokens = usageData.inputTokens || 0;
      const outputTokens = usageData.outputTokens || 0;
      const cacheReadTokens = usageData.cacheReadInputTokens || 0;
      const cacheCreationTokens = usageData.cacheCreationInputTokens || 0;
      const contextWindowLimit = usageData.contextWindow || 0;

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
      // Context window = input + output (simple and reliable)
      // Cache tokens are unreliable and ignored for context window calculation
      contextWindow: totalInput + totalOutput,
      contextWindowLimit: maxLimit,
      primaryModel,
      durationMs,
      costUsd,
    };
  }

  /**
   * Normalize single-model usage (fallback for older SDK versions)
   */
  private normalizeSingleModel(
    usage: unknown,
    durationMs?: number,
    costUsd?: number
  ): NormalizedSdkData {
    // biome-ignore lint/suspicious/noExplicitAny: SDK usage object has dynamic structure
    const usageData = usage as any;
    const inputTokens = usageData.input_tokens || 0;
    const outputTokens = usageData.output_tokens || 0;
    const cacheReadTokens = usageData.cache_read_input_tokens || 0;
    const cacheCreationTokens = usageData.cache_creation_input_tokens || 0;

    return {
      tokenUsage: {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        cacheReadTokens,
        cacheCreationTokens,
      },
      // Context window = input + output (simple and reliable)
      // Cache tokens are unreliable and ignored for context window calculation
      contextWindow: inputTokens + outputTokens,
      // Default to 200K for Claude models (standard context window)
      contextWindowLimit: 200000,
      durationMs,
      costUsd,
    };
  }
}
