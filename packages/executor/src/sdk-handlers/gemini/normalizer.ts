/**
 * Gemini SDK Response Normalizer
 *
 * Transforms Gemini SDK's raw Finished event into standardized format.
 *
 * The raw event structure from Gemini SDK (via Finished event):
 * {
 *   usageMetadata: {
 *     promptTokenCount,
 *     candidatesTokenCount,
 *     totalTokenCount,
 *     cachedContentTokenCount? (optional)
 *   },
 *   model: string (optional)
 * }
 *
 * Key responsibilities:
 * - Extract token usage from raw SDK event
 * - Map cachedContentTokenCount to cacheReadTokens for consistency
 * - Calculate context window usage
 * - Determine context window limit (Gemini doesn't provide this in event)
 *
 * Note on `primaryModel`: the Finished event does not reliably carry the
 * model name, so we leave `primaryModel` undefined here. The authoritative
 * resolved model lives on `session.model_config.model` and is patched onto
 * the task via gemini-tool / base-executor's tool-result fallback path.
 * Leaving it undefined avoids overwriting the resolved model with a stale
 * default (the same bug fixed for Codex in this commit).
 */

import type { GeminiSdkResponse } from '../../types/sdk-response.js';
import type { INormalizer, NormalizedSdkData } from '../base/normalizer.interface.js';
import type { NormalizeOptions } from '../normalizer-factory.js';
import { DEFAULT_GEMINI_MODEL, getGeminiContextWindowLimit } from './models.js';

export class GeminiNormalizer implements INormalizer<GeminiSdkResponse> {
  /**
   * `options.modelHint` is the configured/resolved model from
   * `session.model_config.model`. Gemini's Finished event doesn't
   * reliably carry a model, so without the hint the context-window
   * limit defaults to the tool's default model — which can disagree
   * with `Task.model` once we record the user's actual selection. The
   * hint refines the limit lookup only; it is **never** propagated to
   * `primaryModel`, which stays bound to "did the SDK event actually
   * echo a model?".
   */
  normalize(event: GeminiSdkResponse, options?: NormalizeOptions): NormalizedSdkData {
    // Extract usageMetadata from ServerGeminiFinishedEvent
    // Note: event.value can be undefined in some cases (e.g., errors, incomplete responses)
    const usageMetadata = event.value?.usageMetadata;
    const inputTokens = usageMetadata?.promptTokenCount ?? 0;
    const outputTokens = usageMetadata?.candidatesTokenCount ?? 0;
    const cacheReadTokens = usageMetadata?.cachedContentTokenCount ?? 0;

    const lookupModel = options?.modelHint || DEFAULT_GEMINI_MODEL;
    const contextWindowLimit = getGeminiContextWindowLimit(lookupModel);

    return {
      tokenUsage: {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        cacheReadTokens,
        cacheCreationTokens: 0, // Gemini doesn't provide this
      },
      contextWindowLimit,
      // Intentionally omit primaryModel — see file header.
      durationMs: undefined, // Not available in raw SDK event
    };
  }
}
