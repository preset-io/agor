/**
 * Copilot SDK normalizer. `model` on the raw response is the configured
 * model the adapter recorded (the SDK doesn't echo one today); it's
 * propagated to `primaryModel` only when present.
 */

import type { INormalizer, NormalizedSdkData } from '../base/normalizer.interface.js';
import { DEFAULT_COPILOT_MODEL, getCopilotContextWindowLimit } from './models.js';

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
    const contextWindowLimit = getCopilotContextWindowLimit(
      response.model || DEFAULT_COPILOT_MODEL
    );
    const usage = response.usage;
    if (!usage) {
      return {
        tokenUsage: {
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        },
        contextWindowLimit,
        ...(response.model ? { primaryModel: response.model } : {}),
        durationMs: undefined,
      };
    }
    const inputTokens = usage.input_tokens || 0;
    const outputTokens = usage.output_tokens || 0;
    return {
      tokenUsage: {
        inputTokens,
        outputTokens,
        totalTokens: usage.total_tokens || inputTokens + outputTokens,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      },
      contextWindowLimit,
      ...(response.model ? { primaryModel: response.model } : {}),
      durationMs: undefined,
    };
  }
}
