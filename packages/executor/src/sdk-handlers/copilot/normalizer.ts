/**
 * Copilot SDK Response Normalizer
 *
 * Transforms Copilot SDK's raw response into standardized format.
 *
 * The raw response structure from Copilot SDK:
 * {
 *   usage: { input_tokens, output_tokens, total_tokens },
 *   model: string,
 *   sessionId: string,
 * }
 *
 * Key responsibilities:
 * - Extract token usage from raw SDK response
 * - Determine context window limit based on model
 * - Map to standardized NormalizedSdkData format
 */

import type { INormalizer, NormalizedSdkData } from '../base/normalizer.interface.js';
import { DEFAULT_COPILOT_MODEL, getCopilotContextWindowLimit } from './models.js';

/**
 * Raw Copilot SDK response shape
 *
 * This represents the accumulated data from Copilot session events,
 * stored in tasks.raw_sdk_response for normalization.
 */
export interface CopilotSdkResponse {
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
  };
  model?: string;
  sessionId?: string;
}

export class CopilotNormalizer implements INormalizer<CopilotSdkResponse> {
  normalize(response: CopilotSdkResponse): NormalizedSdkData {
    const usage = response.usage;

    // Handle missing usage gracefully
    if (!usage) {
      return {
        tokenUsage: {
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        },
        contextWindowLimit: getCopilotContextWindowLimit(response.model || DEFAULT_COPILOT_MODEL),
        primaryModel: response.model || DEFAULT_COPILOT_MODEL,
        durationMs: undefined,
      };
    }

    const inputTokens = usage.input_tokens || 0;
    const outputTokens = usage.output_tokens || 0;
    const model = response.model || DEFAULT_COPILOT_MODEL;

    return {
      tokenUsage: {
        inputTokens,
        outputTokens,
        totalTokens: usage.total_tokens || inputTokens + outputTokens,
        cacheReadTokens: 0, // Copilot SDK doesn't expose cache metrics
        cacheCreationTokens: 0,
      },
      contextWindowLimit: getCopilotContextWindowLimit(model),
      primaryModel: model,
      durationMs: undefined, // Not available in raw SDK response
    };
  }
}
