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
 */

import type { GeminiSdkResponse } from '../../types/sdk-response.js';
import type { INormalizer, NormalizedSdkData } from '../base/normalizer.interface.js';
import { DEFAULT_GEMINI_MODEL, getGeminiContextWindowLimit } from './models.js';

export class GeminiNormalizer implements INormalizer<GeminiSdkResponse> {
  normalize(event: GeminiSdkResponse): NormalizedSdkData {
    // Extract usageMetadata from ServerGeminiFinishedEvent
    // Note: event.value can be undefined in some cases (e.g., errors, incomplete responses)
    const usageMetadata = event.value?.usageMetadata;
    const inputTokens = usageMetadata?.promptTokenCount ?? 0;
    const outputTokens = usageMetadata?.candidatesTokenCount ?? 0;
    const cacheReadTokens = usageMetadata?.cachedContentTokenCount ?? 0;

    // Context window = input_tokens + output_tokens
    // NOTE: promptTokenCount = context sent to model in THIS turn (includes conversation history)
    // candidatesTokenCount = response generated in THIS turn (will be context for NEXT turn)
    // Get context window limit based on model (Gemini doesn't include model in event)
    const contextWindowLimit = getGeminiContextWindowLimit(DEFAULT_GEMINI_MODEL);

    return {
      tokenUsage: {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        cacheReadTokens,
        cacheCreationTokens: 0, // Gemini doesn't provide this
      },
      contextWindowLimit,
      primaryModel: DEFAULT_GEMINI_MODEL,
      durationMs: undefined, // Not available in raw SDK event
    };
  }
}
