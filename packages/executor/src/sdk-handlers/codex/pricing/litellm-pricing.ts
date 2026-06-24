// Filtered vendored snapshot from LiteLLM's pricing catalog. When OpenAI ships
// new Codex models or prices change, refresh this file from:
// https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json
import modelPrices from './litellm-openai-model-prices.json' with { type: 'json' };

interface LiteLlmModelPricing {
  input_cost_per_token?: number;
  input_cost_per_token_above_272k_tokens?: number;
  output_cost_per_token?: number;
  output_cost_per_token_above_272k_tokens?: number;
  cache_read_input_token_cost?: number;
  cache_read_input_token_cost_above_272k_tokens?: number;
}

const prices = modelPrices as Record<string, LiteLlmModelPricing>;

function normalizeModelId(modelId: string): string {
  return modelId.trim().replace(/^openai\//, '');
}

export function getLiteLlmPricingForModel(modelId: string): LiteLlmModelPricing | undefined {
  const normalized = normalizeModelId(modelId);
  return prices[normalized] ?? prices[modelId];
}

export interface CodexEstimatedCostInput {
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
}

/**
 * Estimate Codex API-equivalent cost from token usage and LiteLLM's pricing map.
 *
 * This is deliberately an estimate:
 * - Codex SDK does not provide per-turn cost.
 * - Codex `turn.completed.usage` is cumulative across the agent loop, so it
 *   cannot tell us whether any single model request crossed a long-context
 *   pricing tier. Use base per-token prices until a per-request tier signal is
 *   available.
 * - ChatGPT subscription/native-auth Codex billing may not equal API pricing.
 * - Service tiers, batch/flex/priority, regional uplifts, and non-token tool
 *   charges are not inferred from `turn.completed.usage`.
 */
export function estimateCodexCostUsd(input: CodexEstimatedCostInput): number | undefined {
  const pricing = getLiteLlmPricingForModel(input.modelId);
  if (!pricing) return undefined;

  const inputTokens = Math.max(0, input.inputTokens || 0);
  const outputTokens = Math.max(0, input.outputTokens || 0);
  const cacheReadTokens = Math.min(Math.max(0, input.cacheReadTokens || 0), inputTokens);
  const uncachedInputTokens = Math.max(0, inputTokens - cacheReadTokens);

  const inputCostPerToken = pricing.input_cost_per_token;
  const outputCostPerToken = pricing.output_cost_per_token;
  const cacheReadCostPerToken = pricing.cache_read_input_token_cost ?? inputCostPerToken;

  if (uncachedInputTokens > 0 && inputCostPerToken === undefined) return undefined;
  if (cacheReadTokens > 0 && cacheReadCostPerToken === undefined) return undefined;
  if (outputTokens > 0 && outputCostPerToken === undefined) return undefined;

  return (
    uncachedInputTokens * (inputCostPerToken ?? 0) +
    cacheReadTokens * (cacheReadCostPerToken ?? 0) +
    outputTokens * (outputCostPerToken ?? 0)
  );
}
