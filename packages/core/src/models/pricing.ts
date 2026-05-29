/**
 * OpenAI text-model pricing used for Codex cost estimation.
 *
 * Rates are USD per 1M tokens and are intentionally limited to models we have
 * verified in current official OpenAI docs. Unknown / preview-only models
 * return `null` so callers can show "cost unavailable" instead of a misleading
 * zero.
 */

export interface OpenAITextModelPricing {
  /** USD per 1M input tokens. */
  inputPerMTok: number;
  /**
   * USD per 1M cached input tokens.
   *
   * When omitted, cached tokens are billed at the normal input rate (used by
   * models that do not offer a cache discount, e.g. `*-pro` variants).
   */
  cachedInputPerMTok?: number;
  /** USD per 1M output tokens. */
  outputPerMTok: number;
}

const OPENAI_TEXT_MODEL_PRICING: ReadonlyArray<{
  prefix: string;
  price: OpenAITextModelPricing;
}> = [
  {
    prefix: 'gpt-5.5-pro',
    price: {
      inputPerMTok: 30,
      outputPerMTok: 180,
    },
  },
  {
    prefix: 'gpt-5.5',
    price: {
      inputPerMTok: 5,
      cachedInputPerMTok: 0.5,
      outputPerMTok: 30,
    },
  },
  {
    prefix: 'gpt-5.4-pro',
    price: {
      inputPerMTok: 30,
      outputPerMTok: 180,
    },
  },
  {
    prefix: 'gpt-5.4-mini',
    price: {
      inputPerMTok: 0.75,
      cachedInputPerMTok: 0.075,
      outputPerMTok: 4.5,
    },
  },
  {
    prefix: 'gpt-5.4-nano',
    price: {
      inputPerMTok: 0.2,
      cachedInputPerMTok: 0.02,
      outputPerMTok: 1.25,
    },
  },
  {
    prefix: 'gpt-5.4',
    price: {
      inputPerMTok: 2.5,
      cachedInputPerMTok: 0.25,
      outputPerMTok: 15,
    },
  },
  {
    prefix: 'gpt-5.3-codex',
    price: {
      inputPerMTok: 1.75,
      cachedInputPerMTok: 0.175,
      outputPerMTok: 14,
    },
  },
  {
    prefix: 'gpt-5.2-pro',
    price: {
      inputPerMTok: 21,
      outputPerMTok: 168,
    },
  },
  {
    prefix: 'gpt-5.2-codex',
    price: {
      inputPerMTok: 1.75,
      cachedInputPerMTok: 0.175,
      outputPerMTok: 14,
    },
  },
  {
    prefix: 'gpt-5.2',
    price: {
      inputPerMTok: 1.75,
      cachedInputPerMTok: 0.175,
      outputPerMTok: 14,
    },
  },
  {
    prefix: 'gpt-5.1-codex-max',
    price: {
      inputPerMTok: 1.25,
      cachedInputPerMTok: 0.125,
      outputPerMTok: 10,
    },
  },
  {
    prefix: 'gpt-5.1-codex-mini',
    price: {
      inputPerMTok: 0.25,
      cachedInputPerMTok: 0.025,
      outputPerMTok: 2,
    },
  },
  {
    prefix: 'gpt-5.1-codex',
    price: {
      inputPerMTok: 1.25,
      cachedInputPerMTok: 0.125,
      outputPerMTok: 10,
    },
  },
  {
    prefix: 'gpt-5.1',
    price: {
      inputPerMTok: 1.25,
      cachedInputPerMTok: 0.125,
      outputPerMTok: 10,
    },
  },
  {
    prefix: 'gpt-5-codex',
    price: {
      inputPerMTok: 1.25,
      cachedInputPerMTok: 0.125,
      outputPerMTok: 10,
    },
  },
  {
    prefix: 'codex-mini-latest',
    price: {
      inputPerMTok: 1.5,
      cachedInputPerMTok: 0.375,
      outputPerMTok: 6,
    },
  },
  {
    prefix: 'gpt-5',
    price: {
      inputPerMTok: 1.25,
      cachedInputPerMTok: 0.125,
      outputPerMTok: 10,
    },
  },
  {
    prefix: 'gpt-4o-mini',
    price: {
      inputPerMTok: 0.15,
      cachedInputPerMTok: 0.075,
      outputPerMTok: 0.6,
    },
  },
  {
    prefix: 'gpt-4o',
    price: {
      inputPerMTok: 2.5,
      cachedInputPerMTok: 1.25,
      outputPerMTok: 10,
    },
  },
];

/**
 * Longest-prefix lookup so snapshot suffixes like `gpt-5.4-2026-03-05`
 * resolve against the stable model entry.
 */
export function getOpenAITextModelPricing(
  modelId: string | null | undefined
): OpenAITextModelPricing | null {
  if (!modelId) return null;

  let best: { prefix: string; price: OpenAITextModelPricing } | null = null;
  for (const entry of OPENAI_TEXT_MODEL_PRICING) {
    const isExact = modelId === entry.prefix;
    const isSnapshot =
      modelId.startsWith(`${entry.prefix}-`) &&
      /\d/.test(modelId.charAt(entry.prefix.length + 1) || '');
    if (isExact || isSnapshot) {
      if (!best || entry.prefix.length > best.prefix.length) {
        best = entry;
      }
    }
  }

  return best?.price ?? null;
}

export interface OpenAITextUsage {
  /**
   * Total input tokens, INCLUDING cached-input tokens when the API reports
   * them as a detail field.
   */
  inputTokens: number;
  /** Cached-input subset of `inputTokens`. */
  cachedInputTokens?: number;
  outputTokens: number;
}

/**
 * Compute estimated USD cost for OpenAI text models from usage counters.
 *
 * OpenAI Responses usage reports `input_tokens` as the total input, with
 * `cached_tokens` / `cached_input_tokens` as a subset detail. We therefore
 * subtract cached tokens from the base-input bucket before pricing.
 */
export function computeOpenAITextCost(
  modelId: string | null | undefined,
  usage: OpenAITextUsage | null | undefined
): number | undefined {
  const price = getOpenAITextModelPricing(modelId);
  if (!price || !usage) return undefined;

  const inputTokens = Math.max(0, usage.inputTokens || 0);
  const cachedInputTokens = Math.max(0, Math.min(inputTokens, usage.cachedInputTokens || 0));
  const uncachedInputTokens = Math.max(0, inputTokens - cachedInputTokens);
  const outputTokens = Math.max(0, usage.outputTokens || 0);
  const cachedRate = price.cachedInputPerMTok ?? price.inputPerMTok;
  const M = 1_000_000;

  return (
    (uncachedInputTokens * price.inputPerMTok) / M +
    (cachedInputTokens * cachedRate) / M +
    (outputTokens * price.outputPerMTok) / M
  );
}
