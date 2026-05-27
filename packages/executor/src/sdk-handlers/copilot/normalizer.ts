/**
 * Copilot SDK Response Normalizer
 *
 * Transforms Copilot SDK's raw response into standardized format.
 *
 * The raw response structure (as Agor records it):
 * {
 *   usage?:   { input_tokens, output_tokens, total_tokens },
 *   model?:   string,    // configured model from session.model_config —
 *                        // recorded by CopilotPromptService, NOT an SDK
 *                        // echo (the SDK doesn't expose one today).
 *   sessionId?: string,
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
 * stored in tasks.raw_sdk_response for normalization. `model` is the
 * Agor-side configured model that the adapter recorded into the blob
 * — not currently an SDK echo. Optional because legacy/no-model_config
 * rows omit it; consumers must handle absence.
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

    // The context-window lookup needs *some* key — fall back to the tool
    // default only for that table lookup (so the popover shows a sensible
    // limit even on legacy rows). We deliberately do NOT propagate that
    // fallback into `primaryModel`; see file header for the contract.
    const lookupModel = response.model || DEFAULT_COPILOT_MODEL;
    const contextWindowLimit = getCopilotContextWindowLimit(lookupModel);

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
        contextWindowLimit,
        // Conditional spread: omit the key entirely when unknown, matching
        // the `buildAssistantMessageMetadata` contract and the
        // no-substitution rule on `normalizer.interface.ts`.
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
        cacheReadTokens: 0, // Copilot SDK doesn't expose cache metrics
        cacheCreationTokens: 0,
      },
      contextWindowLimit,
      // Same rationale as the no-usage branch above.
      ...(response.model ? { primaryModel: response.model } : {}),
      durationMs: undefined, // Not available in raw SDK response
    };
  }
}
