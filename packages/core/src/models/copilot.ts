/**
 * Copilot Model Constants
 *
 * GitHub Copilot SDK ships `client.listModels()` for live discovery — the
 * daemon surfaces that as a Feathers endpoint, and the UI calls it on mount.
 * The static metadata below is the offline fallback (first-load, no token,
 * dynamic call fails) and the source for the agor_models_list MCP tool.
 */

/** Default Copilot model used when no model is specified */
export const DEFAULT_COPILOT_MODEL = 'gpt-4o';

const _COPILOT_MODEL_METADATA = {
  'gpt-4o': {
    name: 'GPT-4o',
    description: 'OpenAI general-purpose multimodal model',
    provider: 'OpenAI',
  },
  'gpt-4o-mini': {
    name: 'GPT-4o Mini',
    description: 'Smaller, faster GPT-4o variant',
    provider: 'OpenAI',
  },
  'claude-sonnet-4-20250514': {
    name: 'Claude Sonnet 4',
    description: 'Anthropic Claude Sonnet 4',
    provider: 'Anthropic',
  },
  'o3-mini': {
    name: 'o3 Mini',
    description: 'OpenAI reasoning model, smaller variant',
    provider: 'OpenAI',
  },
  'o4-mini': {
    name: 'o4 Mini',
    description: 'OpenAI reasoning model, smaller variant',
    provider: 'OpenAI',
  },
} as const satisfies Record<string, { name: string; description: string; provider: string }>;

export const COPILOT_MODEL_METADATA = _COPILOT_MODEL_METADATA;

/** Known Copilot model IDs (literal union from metadata) */
export type CopilotModel = keyof typeof _COPILOT_MODEL_METADATA;

/** Backwards-compat: tuple of known model IDs */
export const COPILOT_MODELS = Object.keys(COPILOT_MODEL_METADATA) as CopilotModel[];

const DEFAULT_COPILOT_CONTEXT_LIMIT = 128_000;

export const COPILOT_CONTEXT_LIMITS: Record<string, number> = {
  'gpt-4o': 128_000,
  'gpt-4o-mini': 128_000,
  'claude-sonnet-4-20250514': 200_000,
  'o3-mini': 200_000,
  'o4-mini': 200_000,
};

export function getCopilotContextWindowLimit(model?: string): number {
  if (!model) return DEFAULT_COPILOT_CONTEXT_LIMIT;
  return COPILOT_CONTEXT_LIMITS[model] ?? DEFAULT_COPILOT_CONTEXT_LIMIT;
}
