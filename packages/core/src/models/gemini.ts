/**
 * Gemini model definitions and selection
 *
 * Reference: https://ai.google.dev/gemini-api/docs/models
 */

import { GoogleGenAI } from '@google/genai';

/**
 * Available Gemini models (2025)
 *
 * NOTE: This list is used as a fallback when dynamic model fetching fails.
 * Models are fetched dynamically from the Gemini API when possible.
 */
export type GeminiModel =
  | 'gemini-3-pro' // Latest and most intelligent (Nov 2025+, requires waitlist/Ultra subscription)
  | 'gemini-2.5-pro' // Most capable 2.5 model, complex reasoning (SWE-bench: 63.8%)
  | 'gemini-2.5-flash' // Balanced cost/capability, agentic tasks
  | 'gemini-2.5-flash-lite' // High throughput, low cost, simple tasks
  | 'gemini-2.0-flash' // Default model since Jan 30, 2025
  | 'gemini-2.0-flash-lite' // Ultra-efficient for simple, high-frequency tasks
  | 'gemini-2.0-pro' // Released Feb 5, 2025
  | 'gemini-2.0-flash-thinking-experimental'; // Shows reasoning process

/**
 * Default model for new Gemini sessions
 *
 * Using Flash 2.0 (Google's default since Jan 30, 2025) for best balance.
 * Users can upgrade to Flash 2.5, Pro 2.5, or Pro 3 for different needs.
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
    inputPrice: string; // $ per 1M tokens
    outputPrice: string; // $ per 1M tokens
    useCase: string;
  }
> = {
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
 * All Gemini 2.0+ models support 1M input tokens + 65k output tokens.
 * Reference: https://ai.google.dev/gemini-api/docs/models/gemini
 */
export const GEMINI_CONTEXT_LIMITS: Record<string, number> = {
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

  // Handle versioned models like "gemini-2.5-pro-001"
  for (const [key, limit] of Object.entries(GEMINI_CONTEXT_LIMITS)) {
    if (normalized.startsWith(`${key}-`)) {
      return limit;
    }
  }

  return DEFAULT_GEMINI_CONTEXT_LIMIT;
}

// ============================================================
// Dynamic Model Fetching (NEW)
// ============================================================

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
 * Cache for dynamically fetched models
 */
interface ModelCache {
  models: GeminiModelInfo[];
  timestamp: number;
  expiresAt: number;
}

let modelCache: ModelCache | null = null;
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Fetch available Gemini models from the API
 *
 * Uses @google/genai's GoogleGenAI.models.list() to fetch current models.
 * Results are cached for 24 hours to reduce API calls.
 *
 * @param apiKey - Google AI API key (required)
 * @param forceRefresh - Force refresh cache (default: false)
 * @returns Array of available models with their metadata
 *
 * @example
 * ```typescript
 * // Fetch models with API key
 * const models = await fetchGeminiModels('your-api-key');
 *
 * // Use cached models (if available)
 * const cachedModels = await fetchGeminiModels('your-api-key');
 *
 * // Force refresh cache
 * const fresh = await fetchGeminiModels('your-api-key', true);
 * ```
 */
export async function fetchGeminiModels(
  apiKey?: string,
  forceRefresh = false
): Promise<GeminiModelInfo[]> {
  // Return cached models if available and not expired
  if (!forceRefresh && modelCache && Date.now() < modelCache.expiresAt) {
    return modelCache.models;
  }

  if (!apiKey) {
    throw new Error('API key required for fetching Gemini models');
  }

  try {
    const genAI = new GoogleGenAI({ apiKey });

    // Fetch models from API
    const models: GeminiModelInfo[] = [];
    const pager = await genAI.models.list();

    for await (const model of pager) {
      // Only include models that support generateContent
      if (model.supportedActions?.includes('generateContent') && model.name) {
        models.push({
          name: model.name.replace('models/', ''), // Remove "models/" prefix
          displayName: model.displayName || model.name,
          description: model.description,
          supportedActions: model.supportedActions || [],
          inputTokenLimit: model.inputTokenLimit,
          outputTokenLimit: model.outputTokenLimit,
        });
      }
    }

    // Cache the results
    modelCache = {
      models,
      timestamp: Date.now(),
      expiresAt: Date.now() + CACHE_TTL,
    };

    return models;
  } catch (error) {
    console.warn('Failed to fetch Gemini models from API:', error);
    // Return cached models if available (even if expired)
    if (modelCache) {
      console.warn('Using expired cache as fallback');
      return modelCache.models;
    }
    // Fallback to hardcoded list
    throw error;
  }
}

/**
 * Get all available Gemini models (dynamic + fallback)
 *
 * Attempts to fetch models from API, falls back to hardcoded list if it fails.
 *
 * @param apiKey - Google AI API key (optional)
 * @returns Array of model names
 */
export async function getAvailableGeminiModels(apiKey?: string): Promise<string[]> {
  try {
    const dynamicModels = await fetchGeminiModels(apiKey);
    return dynamicModels.map((m) => m.name);
  } catch (_error) {
    console.warn('Using hardcoded Gemini model list as fallback');
    return Object.keys(GEMINI_MODELS) as GeminiModel[];
  }
}

/**
 * Clear the model cache (useful for testing or forcing refresh)
 */
export function clearGeminiModelCache(): void {
  modelCache = null;
}
