/**
 * Codex Model Constants
 *
 * OpenAI Codex model identifiers and defaults
 */

/** Default Codex model */
export const DEFAULT_CODEX_MODEL = 'gpt-5.3-codex';

/** Codex Mini model (GPT-5-Codex-Mini for cost-effective usage) */
export const CODEX_MINI_MODEL = 'gpt-5-codex-mini';

/**
 * Model metadata for UI display (single source of truth).
 *
 * Order matters — the UI dropdown renders models in this order,
 * and the first entry is used as the default for alias mode.
 *
 * Uses `as const satisfies` to preserve literal key types for CodexModel.
 */
const _CODEX_MODEL_METADATA = {
  // GPT-5.3 models (newest)
  'gpt-5.3-codex': {
    name: 'GPT-5.3 Codex (Recommended)',
    description: 'Most capable agentic coding model - stronger reasoning, 25% faster',
  },
  // GPT-5.2 models
  'gpt-5.2-codex': {
    name: 'GPT-5.2 Codex',
    description: 'Advanced coding model optimized for agentic tasks - 400k context',
  },
  'gpt-5.2': {
    name: 'GPT-5.2',
    description: 'Best for complex tasks - 400k context, thinking mode',
  },
  'gpt-5.2-pro': {
    name: 'GPT-5.2 Pro',
    description: 'Highest accuracy, xhigh reasoning for difficult problems',
  },
  'gpt-5.2-instant': {
    name: 'GPT-5.2 Instant',
    description: 'Faster model for writing and information seeking',
  },
  // GPT-5.1 models
  'gpt-5.1-codex-max': {
    name: 'GPT-5.1 Codex Max',
    description: 'Optimized for long-horizon agentic coding',
  },
  'gpt-5.1-codex': {
    name: 'GPT-5.1 Codex',
    description: 'Optimized for agentic coding tasks',
  },
  'gpt-5.1-codex-mini': {
    name: 'GPT-5.1 Codex Mini',
    description: 'Cost-effective variant with 4x more usage',
  },
  'gpt-5.1': {
    name: 'GPT-5.1',
    description: 'General purpose GPT-5.1 model',
  },
  // GPT-5 models (legacy)
  'gpt-5-codex': {
    name: 'GPT-5 Codex',
    description: 'Legacy model for software engineering',
  },
  'gpt-5-codex-mini': {
    name: 'GPT-5 Codex Mini',
    description: 'Legacy faster, lighter model',
  },
  'gpt-5': {
    name: 'GPT-5',
    description: 'Legacy general purpose model',
  },
  // GPT-4o models
  'gpt-4o': {
    name: 'GPT-4o',
    description: 'General purpose model',
  },
  'gpt-4o-mini': {
    name: 'GPT-4o Mini',
    description: 'Smaller, faster model',
  },
} as const satisfies Record<string, { name: string; description: string }>;

export const CODEX_MODEL_METADATA = _CODEX_MODEL_METADATA;

/** All known Codex model IDs (literal union) */
export type CodexModel = keyof typeof _CODEX_MODEL_METADATA;

/** Model aliases for Codex (derived from metadata) */
export const CODEX_MODELS = Object.fromEntries(
  Object.keys(CODEX_MODEL_METADATA).map((id) => [id, id])
) as Record<CodexModel, CodexModel>;

const DEFAULT_CODEX_CONTEXT_LIMIT = 200_000;

/**
 * Approximate context window limits for Codex-compatible OpenAI models.
 * Values mirror OpenAI's public docs (Dec 2025) and fall back to 200k if unknown.
 */
export const CODEX_CONTEXT_LIMITS: Record<string, number> = {
  // GPT-5.3 models
  'gpt-5.3-codex': 400_000,
  // GPT-5.2 models (400k context, 128k max output)
  'gpt-5.2-codex': 400_000,
  'gpt-5.2': 400_000,
  'gpt-5.2-pro': 400_000,
  'gpt-5.2-instant': 400_000,
  // GPT-5.1 models
  'gpt-5.1-codex-max': 200_000,
  'gpt-5.1-codex': 200_000,
  'gpt-5.1-codex-mini': 200_000,
  'gpt-5.1': 200_000,
  // GPT-5 models (legacy)
  'gpt-5-codex': 200_000,
  'gpt-5-codex-mini': 200_000,
  'gpt-5': 200_000,
  // GPT-4o models
  'gpt-4o': 128_000,
  'gpt-4o-mini': 64_000,
};

export function getCodexContextWindowLimit(model?: string): number {
  if (!model) return DEFAULT_CODEX_CONTEXT_LIMIT;

  const normalized = model.toLowerCase();
  if (CODEX_CONTEXT_LIMITS[normalized]) {
    return CODEX_CONTEXT_LIMITS[normalized];
  }

  for (const [key, limit] of Object.entries(CODEX_CONTEXT_LIMITS)) {
    if (normalized.startsWith(`${key}-`)) {
      return limit;
    }
  }

  return DEFAULT_CODEX_CONTEXT_LIMIT;
}
