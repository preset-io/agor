/**
 * Browser-safe Gemini model metadata shared across packages.
 */

/**
 * Available Gemini models (2025)
 */
export type GeminiModel =
  | 'gemini-3-flash'
  | 'gemini-3-pro'
  | 'gemini-2.5-pro'
  | 'gemini-2.5-flash'
  | 'gemini-2.5-flash-lite'
  | 'gemini-2.0-flash'
  | 'gemini-2.0-flash-lite'
  | 'gemini-2.0-pro'
  | 'gemini-2.0-flash-thinking-experimental';

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
export const DEFAULT_GEMINI_MODEL: GeminiModel = 'gemini-2.0-flash';

/**
 * Model metadata for UI display
 */
export const GEMINI_MODELS: Record<
  GeminiModel,
  {
    name: string;
    description: string;
    inputPrice: string;
    outputPrice: string;
    useCase: string;
  }
> = {
  'gemini-3-flash': {
    name: 'Gemini 3 Flash',
    description: 'Latest Flash model - fast responses with strong capabilities',
    inputPrice: 'TBD',
    outputPrice: 'TBD',
    useCase: 'General coding tasks, fast iteration, great price-to-performance',
  },
  'gemini-3-pro': {
    name: 'Gemini 3 Pro',
    description: 'Latest and most intelligent model (requires Ultra subscription or waitlist)',
    inputPrice: 'Premium',
    outputPrice: 'Premium',
    useCase: 'Most complex tasks, advanced reasoning, state-of-the-art performance',
  },
  'gemini-2.5-pro': {
    name: 'Gemini 2.5 Pro',
    description: 'Most capable 2.5 model for complex reasoning and multi-step tasks',
    inputPrice: 'Higher',
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
  'gemini-2.0-flash': {
    name: 'Gemini 2.0 Flash',
    description: "Google's default model (Jan 2025) - next-gen features with superior speed",
    inputPrice: '$0.15',
    outputPrice: '$0.60',
    useCase: 'General purpose coding, native tool use, 1M token context',
  },
  'gemini-2.0-flash-lite': {
    name: 'Gemini 2.0 Flash-Lite',
    description: 'Ultra-efficient for simple, high-frequency tasks',
    inputPrice: '$0.075',
    outputPrice: '$0.30',
    useCase: 'Simple edits, quick queries, high-volume operations',
  },
  'gemini-2.0-pro': {
    name: 'Gemini 2.0 Pro',
    description: 'Advanced reasoning and complex problem solving',
    inputPrice: '$1.25',
    outputPrice: '$5.00',
    useCase: 'Complex architecture, advanced algorithms, deep refactoring',
  },
  'gemini-2.0-flash-thinking-experimental': {
    name: 'Gemini 2.0 Flash Thinking (Experimental)',
    description: 'Shows detailed reasoning process when responding',
    inputPrice: '$0.15',
    outputPrice: '$0.60',
    useCase: 'Learning, debugging reasoning, understanding AI decision-making',
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
