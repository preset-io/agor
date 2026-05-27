/**
 * Codex SDK Response Normalizer
 *
 * Transforms Codex SDK's raw turn.completed event into standardized format.
 *
 * The raw event structure (@openai/codex-sdk >= 0.133) is:
 * {
 *   type: 'turn.completed',
 *   usage: {
 *     input_tokens,
 *     cached_input_tokens,
 *     output_tokens,
 *     reasoning_output_tokens  // subset of output_tokens
 *   }
 * }
 *
 * The TurnCompletedEvent payload does NOT include the model name; resolved
 * model is read off ThreadOptions in prompt-service. It also does NOT include
 * total_tokens or model_context_window — those are derived/looked up here.
 *
 * Key responsibilities:
 * - Extract token usage from raw SDK event (totalTokens = input + output)
 * - Map cached_input_tokens to cacheReadTokens for consistency
 * - Determine context window limit based on model registry (best-effort —
 *   the authoritative model_context_window is captured separately from
 *   Codex CLI's event_msg/token_count events in base-executor)
 *
 * Note on `primaryModel`: Codex's turn.completed event has no model field, so
 * we intentionally leave `primaryModel` undefined here. The authoritative
 * resolved model lives on `session.model_config.model` and is patched onto
 * the task by codex-tool / base-executor's tool-result fallback path. Leaving
 * it undefined avoids overwriting the correctly-resolved model with a stale
 * default (the bug fixed in this commit).
 */

import type { CodexSdkResponse } from '../../types/sdk-response.js';
import type { INormalizer, NormalizedSdkData } from '../base/normalizer.interface.js';
import type { NormalizeOptions } from '../normalizer-factory.js';
import { DEFAULT_CODEX_MODEL, getCodexContextWindowLimit } from './models.js';

export class CodexNormalizer implements INormalizer<CodexSdkResponse> {
  /**
   * `options.modelHint` is the configured/resolved model from
   * `session.model_config.model`. Codex's TurnCompletedEvent doesn't
   * carry a model, so without the hint the context-window limit defaults
   * to the tool's default model — which can disagree with `Task.model`
   * once we record the user's actual selection. The hint refines the
   * limit lookup only; it is **never** propagated to `primaryModel`,
   * which stays bound to "did the SDK event actually echo a model?".
   */
  normalize(event: CodexSdkResponse, options?: NormalizeOptions): NormalizedSdkData {
    const lookupModel = options?.modelHint || DEFAULT_CODEX_MODEL;
    const contextWindowLimit = getCodexContextWindowLimit(lookupModel);

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
        contextWindowLimit,
        // Intentionally omit primaryModel — see file header.
        durationMs: undefined,
      };
    }

    const inputTokens = usage.input_tokens || 0;
    const outputTokens = usage.output_tokens || 0;
    const cacheReadTokens = usage.cached_input_tokens || 0;

    return {
      tokenUsage: {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        cacheReadTokens,
        cacheCreationTokens: 0, // Codex doesn't provide this
      },
      contextWindowLimit,
      // Intentionally omit primaryModel — see file header.
      durationMs: undefined, // Not available in raw SDK event
    };
  }
}
