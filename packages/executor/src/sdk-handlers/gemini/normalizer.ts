/** Normalize task-wide usage while preserving the last turn for context accounting. */

import type { GeminiSdkResponse } from '../../types/sdk-response.js';
import type { INormalizer, NormalizedSdkData } from '../base/normalizer.interface.js';
import type { NormalizeOptions } from '../normalizer-factory.js';
import { DEFAULT_GEMINI_MODEL, getGeminiContextWindowLimit } from './models.js';

export class GeminiNormalizer implements INormalizer<GeminiSdkResponse> {
  normalize(event: GeminiSdkResponse, options?: NormalizeOptions): NormalizedSdkData {
    const usageMetadata = event.value?.usageMetadata;
    const inputTokens = event.agor?.usage.input_tokens ?? usageMetadata?.promptTokenCount ?? 0;
    const outputTokens =
      event.agor?.usage.output_tokens ?? usageMetadata?.candidatesTokenCount ?? 0;
    return {
      tokenUsage: {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        cacheReadTokens:
          event.agor?.usage.cache_read_tokens ?? usageMetadata?.cachedContentTokenCount ?? 0,
        cacheCreationTokens: 0,
      },
      contextWindowLimit: getGeminiContextWindowLimit(options?.modelHint || DEFAULT_GEMINI_MODEL),
      primaryModel: event.agor?.reportedModel,
      durationMs: undefined,
    };
  }
}
