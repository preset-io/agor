import type {
  KnowledgeSemanticSettingsPatch,
  KnowledgeSemanticSettingsPublic,
} from '@agor/core/types';
import { DEFAULT_KNOWLEDGE_SEMANTIC_POLICY } from '@agor/core/types';

export const DEFAULT_KNOWLEDGE_SEMANTIC_SETTINGS: KnowledgeSemanticSettingsPublic = {
  ...DEFAULT_KNOWLEDGE_SEMANTIC_POLICY,
  chunking: { ...DEFAULT_KNOWLEDGE_SEMANTIC_POLICY.chunking },
  indexing: { ...DEFAULT_KNOWLEDGE_SEMANTIC_POLICY.indexing },
  api_key_configured: false,
};

export function normalizeKnowledgeSemanticSettings(
  settings?: Partial<KnowledgeSemanticSettingsPublic> | null
): KnowledgeSemanticSettingsPublic {
  return {
    ...DEFAULT_KNOWLEDGE_SEMANTIC_SETTINGS,
    ...(settings ?? {}),
    chunking: {
      ...DEFAULT_KNOWLEDGE_SEMANTIC_SETTINGS.chunking,
      ...(settings?.chunking ?? {}),
    },
    indexing: {
      ...DEFAULT_KNOWLEDGE_SEMANTIC_SETTINGS.indexing,
      ...(settings?.indexing ?? {}),
    },
  };
}

export function buildKnowledgeSemanticSettingsPatch(
  values: Partial<KnowledgeSemanticSettingsPublic>,
  apiKeyDraft: string,
  clearApiKey: boolean
): KnowledgeSemanticSettingsPatch {
  const settings = normalizeKnowledgeSemanticSettings(values);
  const trimmedApiKey = apiKeyDraft.trim();
  return {
    enabled: settings.enabled,
    provider: settings.provider,
    model: settings.model,
    dimensions: settings.dimensions,
    chunking: { ...settings.chunking },
    indexing: { ...settings.indexing },
    ...(clearApiKey ? { api_key: null } : trimmedApiKey ? { api_key: trimmedApiKey } : {}),
  };
}
