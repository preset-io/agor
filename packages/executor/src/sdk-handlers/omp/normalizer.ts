/**
 * Oh My Pi SDK normalizer.
 *
 * OMP self-reports both token counts and real USD spend per message, so this
 * normalizer passes those through rather than estimating from a price table.
 * It also forwards OMP's own context-window reading as the authoritative
 * snapshot.
 */

import type { INormalizer, NormalizedSdkData } from '../base/normalizer.interface.js';
import { getOmpContextWindowLimit } from './models.js';

/** Raw shape Agor stores for an OMP turn (assembled by `OmpTool`). */
export interface OmpSdkResponse {
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
    totalTokens?: number;
    /** Real spend reported by OMP, already in USD. */
    costUsd?: number;
  };
  model?: string;
  provider?: string;
  /** Context occupancy as read from OMP's `get_state`. */
  contextUsage?: {
    totalTokens?: number;
    maxTokens?: number;
    percentage?: number;
  };
  durationMs?: number;
}

export class OmpNormalizer implements INormalizer<OmpSdkResponse> {
  normalize(response: OmpSdkResponse): NormalizedSdkData {
    const usage = response.usage ?? {};
    const inputTokens = usage.inputTokens ?? 0;
    const outputTokens = usage.outputTokens ?? 0;
    const cacheReadTokens = usage.cacheReadTokens ?? 0;
    const cacheCreationTokens = usage.cacheCreationTokens ?? 0;
    const contextWindowLimit = getOmpContextWindowLimit(response.contextUsage?.maxTokens);

    const snapshot =
      response.contextUsage?.totalTokens !== undefined &&
      response.contextUsage.maxTokens !== undefined
        ? {
            totalTokens: response.contextUsage.totalTokens,
            maxTokens: response.contextUsage.maxTokens,
            percentage:
              response.contextUsage.percentage ??
              Math.round(
                (response.contextUsage.totalTokens / response.contextUsage.maxTokens) * 100
              ),
          }
        : undefined;

    return {
      tokenUsage: {
        inputTokens,
        outputTokens,
        totalTokens: usage.totalTokens ?? inputTokens + outputTokens,
        cacheReadTokens,
        cacheCreationTokens,
      },
      contextWindowLimit,
      ...(snapshot ? { contextUsageSnapshot: snapshot } : {}),
      // Only surface a cost when OMP actually reported spend; a hard 0 would
      // read as "this turn was free" rather than "unknown".
      ...(usage.costUsd !== undefined && usage.costUsd > 0 ? { costUsd: usage.costUsd } : {}),
      ...(response.model ? { primaryModel: response.model } : {}),
      durationMs: response.durationMs,
    };
  }
}
