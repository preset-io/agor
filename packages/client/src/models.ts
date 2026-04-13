import type { GeminiModel, GeminiModelInfo } from '@agor/core/models/browser';
import { GEMINI_MODELS } from '@agor/core/models/browser';

export * from '@agor/core/models/browser';

interface ModelCache {
  models: GeminiModelInfo[];
  expiresAt: number;
}

interface GeminiModelsListResponse {
  models?: Array<{
    name?: string;
    displayName?: string;
    description?: string;
    supportedGenerationMethods?: string[];
    inputTokenLimit?: number;
    outputTokenLimit?: number;
  }>;
}

let modelCache: ModelCache | null = null;
const CACHE_TTL = 24 * 60 * 60 * 1000;

export async function fetchGeminiModels(
  apiKey?: string,
  forceRefresh = false
): Promise<GeminiModelInfo[]> {
  if (!forceRefresh && modelCache && Date.now() < modelCache.expiresAt) {
    return modelCache.models;
  }
  if (!apiKey) {
    throw new Error('API key required for fetching Gemini models');
  }

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`
  );
  if (!response.ok) {
    throw new Error(`Gemini model fetch failed: ${response.status} ${response.statusText}`);
  }

  const payload = (await response.json()) as GeminiModelsListResponse;
  const models: GeminiModelInfo[] = (payload.models ?? [])
    .filter((model) => model.name && model.supportedGenerationMethods?.includes('generateContent'))
    .map((model) => ({
      name: model.name!.replace('models/', ''),
      displayName: model.displayName || model.name!,
      description: model.description,
      supportedActions: model.supportedGenerationMethods ?? [],
      inputTokenLimit: model.inputTokenLimit,
      outputTokenLimit: model.outputTokenLimit,
    }));

  modelCache = {
    models,
    expiresAt: Date.now() + CACHE_TTL,
  };
  return models;
}

export async function getAvailableGeminiModels(apiKey?: string): Promise<string[]> {
  try {
    const dynamicModels = await fetchGeminiModels(apiKey);
    return dynamicModels.map((model) => model.name);
  } catch (_error) {
    return Object.keys(GEMINI_MODELS) as GeminiModel[];
  }
}

export function clearGeminiModelCache(): void {
  modelCache = null;
}
