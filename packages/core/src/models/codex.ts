/**
 * Codex Model Constants
 *
 * OpenAI Codex model identifiers and defaults
 */

/** Default Codex model (GPT-5-Codex optimized for software engineering) */
export const DEFAULT_CODEX_MODEL = 'gpt-5-codex';

/** Codex Mini model (GPT-5-Codex-Mini for cost-effective usage) */
export const CODEX_MINI_MODEL = 'gpt-5-codex-mini';

/** Model aliases for Codex */
export const CODEX_MODELS = {
  // GPT-5.1 models (latest, recommended)
  'gpt-5.1-codex-max': 'gpt-5.1-codex-max', // Optimized for long-horizon agentic coding
  'gpt-5.1-codex': 'gpt-5.1-codex',
  'gpt-5.1-codex-mini': 'gpt-5.1-codex-mini',
  'gpt-5.1': 'gpt-5.1',
  // GPT-5 models (legacy)
  'gpt-5-codex': 'gpt-5-codex',
  'gpt-5-codex-mini': 'gpt-5-codex-mini',
  'gpt-5': 'gpt-5',
  // GPT-4o models
  'gpt-4o': 'gpt-4o',
  'gpt-4o-mini': 'gpt-4o-mini',
} as const;

const DEFAULT_CODEX_CONTEXT_LIMIT = 200_000;

/**
 * Approximate context window limits for Codex-compatible OpenAI models.
 * Values mirror OpenAI's public docs (Nov 2025) and fall back to 200k if unknown.
 */
export const CODEX_CONTEXT_LIMITS: Record<string, number> = {
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
