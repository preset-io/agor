/**
 * Copilot Model Constants
 *
 * Model definitions for GitHub Copilot SDK.
 * Copilot supports dynamic model discovery via client.listModels(),
 * but we define defaults for offline/fallback usage.
 *
 * Note: Copilot with BYOK can use models from any provider
 * (Anthropic, OpenAI, Azure, Ollama), so the model list here
 * represents the default GitHub-hosted models.
 */

/**
 * Known Copilot models (GitHub-hosted)
 */
export const COPILOT_MODELS = [
  'gpt-4o',
  'gpt-4o-mini',
  'claude-sonnet-4-20250514',
  'o3-mini',
  'o4-mini',
] as const;

export type CopilotModel = (typeof COPILOT_MODELS)[number] | string;

/**
 * Default model used when no model is specified
 */
export const DEFAULT_COPILOT_MODEL: CopilotModel = 'gpt-4o';

/**
 * Context window limits for known Copilot models
 */
export const COPILOT_CONTEXT_LIMITS: Record<string, number> = {
  'gpt-4o': 128_000,
  'gpt-4o-mini': 128_000,
  'claude-sonnet-4-20250514': 200_000,
  'o3-mini': 200_000,
  'o4-mini': 200_000,
};

/**
 * Default context window limit when model is unknown
 */
const DEFAULT_CONTEXT_LIMIT = 128_000;

/**
 * Get context window limit for a Copilot model
 */
export function getCopilotContextWindowLimit(model?: string): number {
  if (!model) return DEFAULT_CONTEXT_LIMIT;
  return COPILOT_CONTEXT_LIMITS[model] ?? DEFAULT_CONTEXT_LIMIT;
}

/**
 * Model metadata for UI display
 */
export const COPILOT_MODEL_METADATA: Record<string, { name: string; provider: string }> = {
  'gpt-4o': { name: 'GPT-4o', provider: 'OpenAI' },
  'gpt-4o-mini': { name: 'GPT-4o Mini', provider: 'OpenAI' },
  'claude-sonnet-4-20250514': { name: 'Claude Sonnet 4', provider: 'Anthropic' },
  'o3-mini': { name: 'o3 Mini', provider: 'OpenAI' },
  'o4-mini': { name: 'o4 Mini', provider: 'OpenAI' },
};
