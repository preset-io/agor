/**
 * Token pricing and cost calculation utilities
 *
 * Pricing as of January 2025 (subject to change)
 */

import type { AgenticToolName } from '../types';

/**
 * Token usage data from LLM API responses
 */
export interface TokenUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  cache_read_tokens?: number; // Claude-specific: prompt caching reads
  cache_creation_tokens?: number; // Claude-specific: prompt caching writes
}

/**
 * Pricing per million tokens (USD)
 */
interface ModelPricing {
  input: number; // $ per 1M input tokens
  output: number; // $ per 1M output tokens
  cache_read?: number; // $ per 1M cache read tokens (Claude only)
  cache_creation?: number; // $ per 1M cache creation tokens (Claude only)
}

/**
 * Current pricing by agentic tool
 *
 * NOTE: These prices are estimates based on public API pricing.
 * Actual costs may vary depending on your plan and usage.
 */
const PRICING: Record<AgenticToolName, ModelPricing> = {
  'claude-code': {
    // Claude Sonnet 4.5 pricing
    input: 3.0, // $3 per 1M input tokens
    output: 15.0, // $15 per 1M output tokens
    cache_read: 0.3, // $0.30 per 1M cache read tokens
    cache_creation: 3.75, // $3.75 per 1M cache creation tokens
  },
  codex: {
    // OpenAI GPT-4 Turbo pricing (estimate for Codex)
    input: 10.0, // $10 per 1M input tokens
    output: 30.0, // $30 per 1M output tokens
  },
  gemini: {
    // Gemini 2.0 Flash pricing
    input: 0.075, // $0.075 per 1M input tokens (much cheaper!)
    output: 0.3, // $0.30 per 1M output tokens
  },
};

/**
 * Calculate estimated cost in USD for a given token usage
 *
 * @param usage - Token usage data from LLM API response
 * @param agent - Agentic tool name (determines pricing)
 * @returns Estimated cost in USD (e.g., 0.0234)
 */
export function calculateTokenCost(usage: TokenUsage, agent: AgenticToolName): number {
  const pricing = PRICING[agent];
  if (!pricing) {
    console.warn(`No pricing data for agent: ${agent}`);
    return 0;
  }

  let cost = 0;

  // Input tokens cost
  if (usage.input_tokens) {
    cost += (usage.input_tokens / 1_000_000) * pricing.input;
  }

  // Output tokens cost
  if (usage.output_tokens) {
    cost += (usage.output_tokens / 1_000_000) * pricing.output;
  }

  // Cache read tokens cost (Claude only)
  if (usage.cache_read_tokens && pricing.cache_read) {
    cost += (usage.cache_read_tokens / 1_000_000) * pricing.cache_read;
  }

  // Cache creation tokens cost (Claude only)
  if (usage.cache_creation_tokens && pricing.cache_creation) {
    cost += (usage.cache_creation_tokens / 1_000_000) * pricing.cache_creation;
  }

  return cost;
}

/**
 * Format cost as USD string with appropriate precision
 *
 * @param costUsd - Cost in USD (e.g., 0.0234)
 * @returns Formatted string (e.g., "$0.023")
 */
export function formatCost(costUsd: number): string {
  if (costUsd === 0) return '$0.00';

  // For very small amounts, show more decimal places
  if (costUsd < 0.01) {
    return `$${costUsd.toFixed(4)}`;
  }

  // For normal amounts, show 2 decimal places
  return `$${costUsd.toFixed(2)}`;
}

/**
 * Format token count with thousands separators
 *
 * @param tokens - Token count (e.g., 12345)
 * @returns Formatted string (e.g., "12,345")
 */
export function formatTokenCount(tokens: number): string {
  return tokens.toLocaleString();
}
