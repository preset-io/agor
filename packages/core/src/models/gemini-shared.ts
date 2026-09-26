/**
 * Browser-safe Gemini model metadata shared across packages.
 */

/**
 * Picker and persisted legacy Gemini model identifiers
 */
export type GeminiModel =
  | 'gemini-3.8-flash'
  | 'gemini-3.7-flash'
  | 'gemini-3.5-flash-lite'
  | 'gemini-3.1-pro-preview'
  | 'gemini-2.5-pro'
  | 'gemini-2.5-flash'
  | 'gemini-2.5-flash-lite'
  | 'gemini-2.0-flash'
  | 'gemini-2.0-flash-lite'
  | 'gemini-2.0-pro'
  | 'gemini-2.0-flash-thinking-experimental'
  | 'gemini-3-flash'
  | 'gemini-3-pro';

/**
 * Dynamic model information from Gemini API
 */
export interface GeminiModelInfo {
  name: string;
  displayName: string;
  description?: string;
  supportedActions: string[];
  inputTokenLimit?: number;
  outputTokenLimit?: number;
}

/**
 * Default model for new Gemini sessions
 */
export const DEFAULT_GEMINI_MODEL: GeminiModel = 'gemini-3.8-flash';

/**
 * Model metadata for UI display
 */
export const GEMINI_MODELS = {
  'gemini-3.8-flash': {
    name: 'Gemini 3.8 Flash',
    description: 'Default Flash model',
    inputPrice: 'Estimated',
    outputPrice: 'Estimated',
    useCase: 'General coding',
  },
  'gemini-3.7-flash': {
    name: 'Gemini 3.7 Flash',
    description: 'Flash model',
    inputPrice: 'Estimated',
    outputPrice: 'Estimated',
    useCase: 'General coding',
  },
  'gemini-3.5-flash-lite': {
    name: 'Gemini 3.5 Flash-Lite',
    description: 'Lightweight Flash model',
    inputPrice: 'Estimated',
    outputPrice: 'Estimated',
    useCase: 'Quick edits and searches',
  },
  'gemini-3.1-pro-preview': {
    name: 'Gemini 3.1 Pro (Preview, paid)',
    description: 'Preview model requiring a paid API plan',
    inputPrice: 'Estimated',
    outputPrice: 'Estimated',
    useCase: 'Complex coding tasks',
  },
};

const DEFAULT_GEMINI_CONTEXT_LIMIT = 1_048_576;

/**
 * Context window limits for Gemini models.
 */
export const GEMINI_CONTEXT_LIMITS: Record<string, number> = {
  'gemini-3-flash': 1_048_576,
  'gemini-3-pro': 1_048_576,
  'gemini-2.5-pro': 1_048_576,
  'gemini-2.5-flash': 1_048_576,
  'gemini-2.5-flash-lite': 1_048_576,
  'gemini-2.0-flash': 1_048_576,
  'gemini-2.0-flash-lite': 1_048_576,
  'gemini-2.0-pro': 1_048_576,
  'gemini-2.0-flash-thinking-experimental': 1_048_576,
};

export function getGeminiContextWindowLimit(model?: string): number {
  if (!model) return DEFAULT_GEMINI_CONTEXT_LIMIT;

  const normalized = model.toLowerCase();
  if (GEMINI_CONTEXT_LIMITS[normalized]) {
    return GEMINI_CONTEXT_LIMITS[normalized];
  }

  for (const [key, limit] of Object.entries(GEMINI_CONTEXT_LIMITS)) {
    if (normalized.startsWith(`${key}-`)) {
      return limit;
    }
  }

  return DEFAULT_GEMINI_CONTEXT_LIMIT;
}
