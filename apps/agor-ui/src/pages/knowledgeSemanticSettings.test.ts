import { describe, expect, it } from 'vitest';
import {
  buildKnowledgeSemanticSettingsPatch,
  DEFAULT_KNOWLEDGE_SEMANTIC_SETTINGS,
  normalizeKnowledgeSemanticSettings,
} from './knowledgeSemanticSettings';

describe('Knowledge semantic settings UI helpers', () => {
  it('fills absent server fields from the typed tenant defaults', () => {
    expect(
      normalizeKnowledgeSemanticSettings({
        enabled: true,
        chunking: { ...DEFAULT_KNOWLEDGE_SEMANTIC_SETTINGS.chunking, target_tokens: 640 },
      })
    ).toMatchObject({
      enabled: true,
      provider: 'openai',
      model: 'text-embedding-3-small',
      dimensions: 1536,
      chunking: { target_tokens: 640, max_tokens: 1200 },
      indexing: { paused: false, batch_size: 32, concurrency: 1 },
    });
  });

  it('keeps a configured key when the replacement field is blank', () => {
    const patch = buildKnowledgeSemanticSettingsPatch(
      { ...DEFAULT_KNOWLEDGE_SEMANTIC_SETTINGS, api_key_configured: true },
      '   ',
      false
    );
    expect(patch).not.toHaveProperty('api_key');
  });

  it('uses explicit null only when an admin requests key removal', () => {
    const patch = buildKnowledgeSemanticSettingsPatch(
      DEFAULT_KNOWLEDGE_SEMANTIC_SETTINGS,
      'ignored-replacement',
      true
    );
    expect(patch.api_key).toBeNull();
  });
});
