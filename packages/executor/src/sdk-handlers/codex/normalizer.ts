/**
 * Codex SDK normalizer. The TurnCompletedEvent has no model field, so
 * `primaryModel` stays undefined here — base-executor uses `result.model`
 * for `Task.model`. `options.modelHint` only refines the context-window
 * lookup so it matches the user's selected model.
 */

import type { CodexSdkResponse } from '../../types/sdk-response.js';
import type { INormalizer, NormalizedSdkData } from '../base/normalizer.interface.js';
import type { NormalizeOptions } from '../normalizer-factory.js';
import { DEFAULT_CODEX_MODEL, getCodexContextWindowLimit } from './models.js';
import { estimateCodexCostUsd } from './pricing/litellm-pricing.js';

export class CodexNormalizer implements INormalizer<CodexSdkResponse> {
  normalize(event: CodexSdkResponse, options?: NormalizeOptions): NormalizedSdkData {
    const contextWindowLimit = getCodexContextWindowLimit(
      options?.modelHint || DEFAULT_CODEX_MODEL
    );

    const usage = event.usage;
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
        durationMs: undefined,
      };
    }

    const inputTokens = usage.input_tokens || 0;
    const outputTokens = usage.output_tokens || 0;
    const cacheReadTokens = usage.cached_input_tokens || 0;
    const modelForPricing = options?.modelHint || DEFAULT_CODEX_MODEL;
    const estimatedCostUsd = estimateCodexCostUsd({
      modelId: modelForPricing,
      inputTokens,
      outputTokens,
      cacheReadTokens,
    });

    return {
      tokenUsage: {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        cacheReadTokens,
        cacheCreationTokens: 0,
      },
      contextWindowLimit,
      costUsd: estimatedCostUsd,
      durationMs: undefined,
    };
  }
}
