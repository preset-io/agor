import { describe, expect, it } from 'vitest';
import { buildKnowledgeEmbeddingReuseSql } from './knowledge-embedding-indexer';

function sqlText(query: { queryChunks?: unknown[] }): string {
  return (query.queryChunks ?? [])
    .map((chunk) => {
      const value = (chunk as { value?: unknown }).value;
      return Array.isArray(value) ? value.join('') : '';
    })
    .join('');
}

function sqlParams(query: { queryChunks?: unknown[] }): unknown[] {
  return (query.queryChunks ?? []).filter(
    (chunk) => !Array.isArray((chunk as { value?: unknown }).value)
  );
}

describe('buildKnowledgeEmbeddingReuseSql', () => {
  it('scopes reuse by exact embedding space id and current model dimensions', () => {
    const query = buildKnowledgeEmbeddingReuseSql({
      embeddingSpaceId: 'space-current-vector-cosine',
      model: 'text-embedding-3-small',
      dimensions: 1536,
      limit: 32,
    });

    const text = sqlText(query as never);
    expect(text).toContain("old_u.embedding_status = 'ready'");
    expect(text).toContain('old_u.embedding_model = ');
    expect(text).toContain('old_u.embedding_dimensions = ');
    expect(text).toContain('e.embedding_space_id = ');
    expect(text).toContain('p.content_md5 AS new_embedding_hash');
    expect(text).toContain('embedding_hash = candidates.new_embedding_hash');
    expect(text).not.toContain('old_u.embedding_hash');
    expect(text).not.toContain('embedding_hash = COALESCE');
    expect(text).toContain('ON CONFLICT (unit_id, embedding_space_id)');

    expect(sqlParams(query as never)).toEqual(
      expect.arrayContaining(['space-current-vector-cosine', 'text-embedding-3-small', 1536, 32])
    );
  });
});
