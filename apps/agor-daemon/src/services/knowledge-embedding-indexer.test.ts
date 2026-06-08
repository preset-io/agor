import { describe, expect, it } from 'vitest';
import {
  buildKnowledgeEmbeddingReuseSql,
  mergeEmbeddingReuseIntoNextMetadata,
} from './knowledge-embedding-indexer';

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
    expect(text).toContain('SELECT unit_id, version_id, content_md5');
    expect(text).toContain('p.version_id AS new_version_id');
    expect(text).toContain('prev_v.version_id AS previous_version_id');
    expect(text).toContain('JOIN kb_document_versions new_v');
    expect(text).toContain('LEFT JOIN kb_document_versions prev_v');
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

describe('mergeEmbeddingReuseIntoNextMetadata', () => {
  it('stores reuse telemetry on the previous version metadata', () => {
    expect(
      mergeEmbeddingReuseIntoNextMetadata(
        { owner_note: 'keep me' },
        {
          targetVersionId: 'version-next',
          embeddingSpaceId: 'space-current-vector-cosine',
          provider: 'openai',
          model: 'text-embedding-3-small',
          dimensions: 1536,
          reusedChunks: 24,
          totalChunks: 27,
          updatedAt: '2026-06-08T00:00:00.000Z',
        }
      )
    ).toEqual({
      owner_note: 'keep me',
      embedding_reuse_into_next: {
        target_version_id: 'version-next',
        embedding_space_id: 'space-current-vector-cosine',
        provider: 'openai',
        model: 'text-embedding-3-small',
        dimensions: 1536,
        reused_chunks: 24,
        total_chunks: 27,
        updated_at: '2026-06-08T00:00:00.000Z',
      },
    });
  });

  it('accumulates batched reuse counts for the same target and embedding space', () => {
    const first = mergeEmbeddingReuseIntoNextMetadata(null, {
      targetVersionId: 'version-next',
      embeddingSpaceId: 'space-current-vector-cosine',
      provider: 'openai',
      model: 'text-embedding-3-small',
      dimensions: 1536,
      reusedChunks: 20,
      totalChunks: 27,
      updatedAt: '2026-06-08T00:00:00.000Z',
    });

    expect(
      mergeEmbeddingReuseIntoNextMetadata(first, {
        targetVersionId: 'version-next',
        embeddingSpaceId: 'space-current-vector-cosine',
        provider: 'openai',
        model: 'text-embedding-3-small',
        dimensions: 1536,
        reusedChunks: 10,
        totalChunks: 27,
        updatedAt: '2026-06-08T00:01:00.000Z',
      }).embedding_reuse_into_next
    ).toMatchObject({
      target_version_id: 'version-next',
      reused_chunks: 27,
      total_chunks: 27,
      updated_at: '2026-06-08T00:01:00.000Z',
    });
  });
});
