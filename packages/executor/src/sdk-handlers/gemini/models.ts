/**
 * Gemini model definitions and selection
 *
 * Reference: https://ai.google.dev/gemini-api/docs/models
 */

/**
 * Available Gemini models (2025)
 */
export type GeminiModel =
  | 'gemini-2.5-pro' // Most capable, complex reasoning (SWE-bench: 63.8%)
  | 'gemini-2.5-flash' // Balanced cost/capability, agentic tasks
  | 'gemini-2.5-flash-lite'; // High throughput, low cost, simple tasks

/**
 * Default model for new Gemini sessions
 *
 * Using Flash by default for balanced cost/performance.
 * Users can upgrade to Pro for complex tasks.
 */
export const DEFAULT_GEMINI_MODEL: GeminiModel = 'gemini-2.5-flash';

/**
 * Model metadata for UI display
 */
export const GEMINI_MODELS: Record<
  GeminiModel,
  {
    name: string;
    description: string;
    inputPrice: string; // $ per 1M tokens
    outputPrice: string; // $ per 1M tokens
    useCase: string;
  }
> = {
  'gemini-2.5-pro': {
    name: 'Gemini 2.5 Pro',
    description: 'Most capable model for complex reasoning and multi-step tasks',
    inputPrice: 'Higher', // Pricing not publicly disclosed yet
    outputPrice: 'Higher',
    useCase: 'Complex refactoring, architecture decisions, advanced debugging',
  },
  'gemini-2.5-flash': {
    name: 'Gemini 2.5 Flash',
    description: 'Balanced performance and cost for most agentic coding tasks',
    inputPrice: '$0.30',
    outputPrice: '$2.50',
    useCase: 'Feature development, bug fixes, code reviews, testing',
  },
  'gemini-2.5-flash-lite': {
    name: 'Gemini 2.5 Flash-Lite',
    description: 'Ultra-fast, low-cost model for simple tasks',
    inputPrice: '$0.10',
    outputPrice: '$0.40',
    useCase: 'File search, summaries, simple edits, code formatting',
  },
};

const DEFAULT_GEMINI_CONTEXT_LIMIT = 1_048_576;

/**
 * Context window limits for Gemini 2.5 models.
 * All Gemini 2.5 models support 1M input tokens + 65k output tokens (Nov 2025).
 * Reference: https://ai.google.dev/gemini-api/docs/models/gemini
 */
export const GEMINI_CONTEXT_LIMITS: Record<string, number> = {
  'gemini-2.5-pro': 1_048_576,
  'gemini-2.5-flash': 1_048_576,
  'gemini-2.5-flash-lite': 1_048_576,
};

export function getGeminiContextWindowLimit(model?: string): number {
  if (!model) return DEFAULT_GEMINI_CONTEXT_LIMIT;

  const normalized = model.toLowerCase();
  if (GEMINI_CONTEXT_LIMITS[normalized]) {
    return GEMINI_CONTEXT_LIMITS[normalized];
  }

  // Handle versioned models like "gemini-2.5-pro-001"
  for (const [key, limit] of Object.entries(GEMINI_CONTEXT_LIMITS)) {
    if (normalized.startsWith(`${key}-`)) {
      return limit;
    }
  }

  return DEFAULT_GEMINI_CONTEXT_LIMIT;
}
