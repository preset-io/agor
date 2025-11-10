/**
 * Codex Model Constants
 *
 * OpenAI Codex model identifiers and defaults
 */

/** Default Codex model (GPT-5-Codex optimized for software engineering) */
export const DEFAULT_CODEX_MODEL = 'gpt-5-codex';

/** Codex Mini model (o4-mini based, for CLI) */
export const CODEX_MINI_MODEL = 'codex-mini-latest';

/** Model aliases for Codex */
export const CODEX_MODELS = {
  'gpt-5-codex': 'gpt-5-codex',
  'codex-mini': 'codex-mini-latest',
  'gpt-4o': 'gpt-4o',
  'gpt-4o-mini': 'gpt-4o-mini',
} as const;

const DEFAULT_CODEX_CONTEXT_LIMIT = 200_000;

/**
 * Approximate context window limits for Codex-compatible OpenAI models.
 * Values mirror OpenAI's public docs (Jan 2025) and fall back to 200k if unknown.
 */
export const CODEX_CONTEXT_LIMITS: Record<string, number> = {
  'gpt-5-codex': 200_000,
  'gpt-4o': 128_000,
  'gpt-4o-mini': 64_000,
  'codex-mini-latest': 32_000,
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
