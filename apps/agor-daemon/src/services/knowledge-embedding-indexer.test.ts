import {
  getCurrentTenantDatabase,
  getCurrentTenantId,
  runWithTenantContext,
  runWithTenantDatabaseScope,
} from '@agor/core/db';
import { DEFAULT_KNOWLEDGE_SEMANTIC_POLICY } from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
import { dbTest } from '../../../../packages/core/src/db/test-helpers';
import {
  buildKnowledgeEmbeddingReuseSql,
  isKnowledgeEmbeddingMaterializationSnapshotCurrent,
  KnowledgeEmbeddingIndexer,
  mergeEmbeddingReuseIntoNextMetadata,
} from './knowledge-embedding-indexer';

describe('isKnowledgeEmbeddingMaterializationSnapshotCurrent', () => {
  it('rejects policy, credential, and chunking changes but ignores batch-size tuning', () => {
    const snapshot = DEFAULT_KNOWLEDGE_SEMANTIC_POLICY;

    expect(
      isKnowledgeEmbeddingMaterializationSnapshotCurrent(
        snapshot,
        { ...snapshot, model: 'text-embedding-3-large' },
        'key-a',
        'key-a'
      )
    ).toBe(false);
    expect(
      isKnowledgeEmbeddingMaterializationSnapshotCurrent(
        snapshot,
        {
          ...snapshot,
          chunking: { ...snapshot.chunking, target_tokens: 640 },
        },
        'key-a',
        'key-a'
      )
    ).toBe(false);
    expect(
      isKnowledgeEmbeddingMaterializationSnapshotCurrent(snapshot, snapshot, 'key-a', 'key-b')
    ).toBe(false);
    expect(
      isKnowledgeEmbeddingMaterializationSnapshotCurrent(
        snapshot,
        {
          ...snapshot,
          indexing: { ...snapshot.indexing, batch_size: 64 },
        },
        'key-a',
        'key-a'
      )
    ).toBe(true);
  });
});

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

describe('KnowledgeEmbeddingIndexer wake scheduling', () => {
  dbTest('runs only after commit with request tenant scopes detached', async ({ db }) => {
    vi.useFakeTimers();
    try {
      const indexer = new KnowledgeEmbeddingIndexer(db, { tenantId: 'bootstrap-tenant' });
      const observedScopes: Array<{ tenantId: string | undefined; hasDatabase: boolean }> = [];
      const tick = vi.fn(async () => {
        observedScopes.push({
          tenantId: getCurrentTenantId() as string | undefined,
          hasDatabase: Boolean(getCurrentTenantDatabase()),
        });
      });
      indexer.tick = tick;

      await runWithTenantContext('request-tenant', () =>
        runWithTenantDatabaseScope(db, 'request-tenant', async () => {
          indexer.wake();
          expect(tick).not.toHaveBeenCalled();
        })
      );

      expect(tick).not.toHaveBeenCalled();
      await vi.runAllTimersAsync();
      expect(tick).toHaveBeenCalledTimes(1);
      expect(observedScopes).toEqual([{ tenantId: undefined, hasDatabase: false }]);
    } finally {
      vi.useRealTimers();
    }
  });

  dbTest('does not wake when the surrounding tenant transaction rolls back', async ({ db }) => {
    vi.useFakeTimers();
    try {
      const indexer = new KnowledgeEmbeddingIndexer(db, { tenantId: 'bootstrap-tenant' });
      const tick = vi.fn(async () => {});
      indexer.tick = tick;

      await expect(
        runWithTenantContext('request-tenant', () =>
          runWithTenantDatabaseScope(db, 'request-tenant', async () => {
            indexer.wake();
            throw new Error('rollback');
          })
        )
      ).rejects.toThrow('rollback');

      await vi.runAllTimersAsync();
      expect(tick).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  dbTest('reruns after a wake arrives during an active tick', async ({ db }) => {
    vi.useFakeTimers();
    try {
      const indexer = new KnowledgeEmbeddingIndexer(db, { tenantId: 'bootstrap-tenant' });
      let releaseFirst!: () => void;
      let signalStarted!: () => void;
      const firstStarted = new Promise<void>((resolve) => {
        signalStarted = resolve;
      });
      const holdFirst = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      let calls = 0;
      indexer.indexBatch = vi.fn(async () => {
        calls += 1;
        if (calls === 1) {
          signalStarted();
          await holdFirst;
        }
        return 0;
      });

      const firstTick = indexer.tick();
      await firstStarted;
      indexer.wake();
      releaseFirst();
      await firstTick;
      await vi.runAllTimersAsync();

      expect(indexer.indexBatch).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
