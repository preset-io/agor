import { describe, expect, it } from 'vitest';
import { isSameKnowledgeEmbeddingSpace } from './embeddings';

describe('Knowledge embedding space matching', () => {
  it('requires provider, model, and dimensions to match before reuse', () => {
    const current = { provider: 'openai', model: 'text-embedding-3-small', dimensions: 1536 };

    expect(isSameKnowledgeEmbeddingSpace(current, { ...current })).toBe(true);
    expect(isSameKnowledgeEmbeddingSpace(current, { ...current, provider: 'other' })).toBe(false);
    expect(
      isSameKnowledgeEmbeddingSpace(current, { ...current, model: 'text-embedding-3-large' })
    ).toBe(false);
    expect(isSameKnowledgeEmbeddingSpace(current, { ...current, dimensions: 3072 })).toBe(false);
  });
});
