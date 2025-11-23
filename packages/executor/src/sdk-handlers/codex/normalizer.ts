/**
 * Codex SDK Response Normalizer
 *
 * Transforms Codex SDK's raw turn.completed event into standardized format.
 *
 * The raw event structure from Codex SDK:
 * {
 *   type: 'turn.completed',
 *   usage: { input_tokens, output_tokens, cached_input_tokens },
 *   model: string (optional)
 * }
 *
 * Key responsibilities:
 * - Extract token usage from raw SDK event
 * - Map cached_input_tokens to cacheReadTokens for consistency
 * - Calculate context window from input + cached tokens
 * - Determine context window limit based on model
 */

import type { CodexSdkResponse } from '../../types/sdk-response.js';
import type { INormalizer, NormalizedSdkData } from '../base/normalizer.interface.js';
import { DEFAULT_CODEX_MODEL, getCodexContextWindowLimit } from './models.js';

export class CodexNormalizer implements INormalizer<CodexSdkResponse> {
  normalize(event: CodexSdkResponse): NormalizedSdkData {
    // Extract usage from TurnCompletedEvent
    const usage = event.usage;

    // Handle missing usage gracefully (legacy tasks or malformed responses)
    if (!usage) {
      return {
        tokenUsage: {
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        },
        contextWindowLimit: getCodexContextWindowLimit(DEFAULT_CODEX_MODEL),
        primaryModel: DEFAULT_CODEX_MODEL,
        durationMs: undefined,
      };
    }

    const inputTokens = usage.input_tokens || 0;
    const outputTokens = usage.output_tokens || 0;
    const cacheReadTokens = usage.cached_input_tokens || 0;

    // Get context window limit based on model (Codex doesn't include model in event)
    const contextWindowLimit = getCodexContextWindowLimit(DEFAULT_CODEX_MODEL);

    return {
      tokenUsage: {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        cacheReadTokens,
        cacheCreationTokens: 0, // Codex doesn't provide this
      },
      contextWindowLimit,
      primaryModel: DEFAULT_CODEX_MODEL,
      durationMs: undefined, // Not available in raw SDK event
    };
  }
}
