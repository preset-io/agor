/**
 * Gemini SDK normalizer. Same shape as Codex: event has no reliable model
 * field, so `primaryModel` stays undefined; `options.modelHint` only
 * refines the context-window lookup.
 */

import type { GeminiSdkResponse } from '../../types/sdk-response.js';
import type { INormalizer, NormalizedSdkData } from '../base/normalizer.interface.js';
import type { NormalizeOptions } from '../normalizer-factory.js';
import { DEFAULT_GEMINI_MODEL, getGeminiContextWindowLimit } from './models.js';

export class GeminiNormalizer implements INormalizer<GeminiSdkResponse> {
  normalize(event: GeminiSdkResponse, options?: NormalizeOptions): NormalizedSdkData {
    const usageMetadata = event.value?.usageMetadata;
    const inputTokens = usageMetadata?.promptTokenCount ?? 0;
    const outputTokens = usageMetadata?.candidatesTokenCount ?? 0;
    return {
      tokenUsage: {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        cacheReadTokens: usageMetadata?.cachedContentTokenCount ?? 0,
        cacheCreationTokens: 0,
      },
      contextWindowLimit: getGeminiContextWindowLimit(options?.modelHint || DEFAULT_GEMINI_MODEL),
      durationMs: undefined,
    };
  }
}
