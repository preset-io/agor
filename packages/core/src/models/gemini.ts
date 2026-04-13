/**
 * Gemini model definitions and selection
 *
 * Reference: https://ai.google.dev/gemini-api/docs/models
 */

import { GoogleGenAI } from '@google/genai';
import type { GeminiModel, GeminiModelInfo } from './gemini-shared.js';
import { GEMINI_MODELS } from './gemini-shared.js';

export type { GeminiModel, GeminiModelInfo } from './gemini-shared.js';
export {
  DEFAULT_GEMINI_MODEL,
  GEMINI_CONTEXT_LIMITS,
  GEMINI_MODELS,
  getGeminiContextWindowLimit,
} from './gemini-shared.js';

// ============================================================
// Dynamic Model Fetching (NEW)
// ============================================================

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
