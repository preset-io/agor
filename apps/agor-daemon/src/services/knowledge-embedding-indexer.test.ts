import {
  createTenantScopedDatabaseProxy,
  getCurrentTenantDatabase,
  getCurrentTenantId,
  type KnowledgeEmbeddingRoutingCursor,
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
  knowledgeEmbeddingTopologyDefaults,
  mergeEmbeddingReuseIntoNextMetadata,
} from './knowledge-embedding-indexer';

describe('Knowledge embedding topology defaults', () => {
  it('preserves immediate 1-128 standalone batches and scopes jitter/caps to distributed mode', () => {
    expect(knowledgeEmbeddingTopologyDefaults(false)).toEqual({
      scanBatchSize: 128,
      perTenantBatchSize: 128,
      tickIntervalMs: 30_000,
      startupOffsetMaxMs: 0,
    });
    expect(knowledgeEmbeddingTopologyDefaults(true)).toEqual({
      scanBatchSize: 32,
      perTenantBatchSize: 8,
      tickIntervalMs: 5_000,
      startupOffsetMaxMs: 30_000,
    });
  });
});

describe('Knowledge embedding routing traversal', () => {
  it('inspects a guarded PostgreSQL handle without opening a tenant unit', async () => {
    const db = createTenantScopedDatabaseProxy({ transaction: vi.fn() } as never, {
      requireScope: true,
      label: 'guarded Knowledge indexer database',
    });
    const indexer = new KnowledgeEmbeddingIndexer(db, {
      distributedMode: true,
      discoverHighWater: async () => ({
        createdAt: '2030-01-01T00:00:00.000Z',
        tenantId: 'tenant-a',
        unitId: 'unit-a' as never,
      }),
      discover: async () => ({ refs: [], nextCursor: null }),
    });

    await expect(indexer.checkOnce()).resolves.toMatchObject({ candidates: 0, failures: 0 });
  });

  it('holds one high-water through every page and snapshots a new one only after wrap', async () => {
    const highWaterA: KnowledgeEmbeddingRoutingCursor = {
      createdAt: '2030-01-01T00:00:00.000Z',
      tenantId: 'tenant-z',
      unitId: 'unit-z' as never,
    };
    const midpoint: KnowledgeEmbeddingRoutingCursor = {
      createdAt: '2029-01-01T00:00:00.000Z',
      tenantId: 'tenant-m',
      unitId: 'unit-m' as never,
    };
    const highWaterB: KnowledgeEmbeddingRoutingCursor = {
      createdAt: '2031-01-01T00:00:00.000Z',
      tenantId: 'tenant-new',
      unitId: 'unit-new' as never,
    };
    const discoverHighWater = vi
      .fn<() => Promise<KnowledgeEmbeddingRoutingCursor | null>>()
      .mockResolvedValueOnce(highWaterA)
      .mockResolvedValueOnce(highWaterB);
    const discover = vi
      .fn()
      .mockResolvedValueOnce({ refs: [], nextCursor: midpoint })
      .mockResolvedValueOnce({ refs: [], nextCursor: null })
      .mockResolvedValueOnce({ refs: [], nextCursor: null });
    const indexer = new KnowledgeEmbeddingIndexer({} as never, {
      distributedMode: true,
      discover,
      discoverHighWater,
    });

    await expect(indexer.checkOnce()).resolves.toMatchObject({ saturated: true });
    await expect(indexer.checkOnce()).resolves.toMatchObject({ saturated: false });
    await expect(indexer.checkOnce()).resolves.toMatchObject({ saturated: false });

    expect(discoverHighWater).toHaveBeenCalledTimes(2);
    expect(discover).toHaveBeenNthCalledWith(1, undefined, highWaterA);
    expect(discover).toHaveBeenNthCalledWith(2, midpoint, highWaterA);
    expect(discover).toHaveBeenNthCalledWith(3, undefined, highWaterB);
  });
});

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
      const value = (chunk as { value?: unknown } | undefined)?.value;
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
      claimToken: 'claim-current',
    });

    const text = sqlText(query as never);
    expect(text).toContain("old_u.embedding_status = 'ready'");
    expect(text).toContain('SELECT u.unit_id, u.version_id, u.content_md5');
    expect(text).toContain('d.current_version_id = u.version_id');
    expect(text).toContain('u.embedding_claim_token = ');
    expect(text).toContain('p.version_id AS new_version_id');
    expect(text).toContain('prev_v.version_id AS previous_version_id');
    expect(text).toContain('JOIN kb_document_versions new_v');
    expect(text).toContain('LEFT JOIN kb_document_versions prev_v');
    expect(text).toContain('old_u.embedding_model = ');
    expect(text).toContain('old_u.embedding_dimensions = ');
    expect(text).toContain('JOIN kb_documents old_d');
    expect(text).toContain('old_d.archived = false');
    expect(text).toContain('JOIN kb_namespaces old_n');
    expect(text).toContain('old_n.archived = false');
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
  dbTest(
    'starts standalone immediately and preserves its fixed polling interval',
    async ({ db }) => {
      vi.useFakeTimers();
      try {
        const indexer = new KnowledgeEmbeddingIndexer(db, {
          tenantId: 'bootstrap-tenant',
          tickIntervalMs: 1_000,
          maxIdleIntervalMs: 8_000,
          random: () => 0.5,
        });
        const tick = vi.fn(async () => ({
          candidates: 0,
          claimed: 0,
          indexed: 0,
          failures: 0,
          saturated: false,
        }));
        indexer.tick = tick;
        indexer.start();

        await vi.advanceTimersByTimeAsync(0);
        expect(tick).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(999);
        expect(tick).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(tick).toHaveBeenCalledTimes(2);
        await indexer.stop();
      } finally {
        vi.useRealTimers();
      }
    }
  );

  dbTest(
    'backs off an exhausted full discovery page when no claim can progress',
    async ({ db }) => {
      vi.useFakeTimers();
      try {
        const indexer = new KnowledgeEmbeddingIndexer(db, {
          tenantId: 'bootstrap-tenant',
          distributedMode: true,
          startupOffsetMaxMs: 0,
          tickIntervalMs: 1_000,
          maxIdleIntervalMs: 8_000,
          random: () => 0.5,
        });
        const tick = vi.fn(async () => ({
          candidates: 32,
          claimed: 0,
          indexed: 0,
          failures: 0,
          saturated: false,
        }));
        indexer.tick = tick;
        indexer.start();

        await vi.advanceTimersByTimeAsync(0);
        expect(tick).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1_999);
        expect(tick).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(tick).toHaveBeenCalledTimes(2);
        await indexer.stop();
      } finally {
        vi.useRealTimers();
      }
    }
  );

  dbTest(
    'quickly drains a bounded discovery traversal past an unclaimable page',
    async ({ db }) => {
      vi.useFakeTimers();
      try {
        const indexer = new KnowledgeEmbeddingIndexer(db, {
          tenantId: 'bootstrap-tenant',
          distributedMode: true,
          startupOffsetMaxMs: 0,
          tickIntervalMs: 1_000,
          maxIdleIntervalMs: 8_000,
          random: () => 0.5,
        });
        const tick = vi
          .fn()
          .mockResolvedValueOnce({
            candidates: 32,
            claimed: 0,
            indexed: 0,
            failures: 0,
            saturated: true,
          })
          .mockResolvedValueOnce({
            candidates: 1,
            claimed: 1,
            indexed: 1,
            failures: 0,
            saturated: false,
          });
        indexer.tick = tick;
        indexer.start();

        await vi.advanceTimersByTimeAsync(0);
        expect(tick).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(149);
        expect(tick).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(tick).toHaveBeenCalledTimes(2);
        await indexer.stop();
      } finally {
        vi.useRealTimers();
      }
    }
  );

  dbTest('runs only after commit with request tenant scopes detached', async ({ db }) => {
    vi.useFakeTimers();
    try {
      const indexer = new KnowledgeEmbeddingIndexer(db, {
        tenantId: 'bootstrap-tenant',
        random: () => 1,
      });
      const observedScopes: Array<{ tenantId: string | undefined; hasDatabase: boolean }> = [];
      const tick = vi.fn(async () => {
        observedScopes.push({
          tenantId: getCurrentTenantId() as string | undefined,
          hasDatabase: Boolean(getCurrentTenantDatabase()),
        });
        return {
          candidates: 0,
          claimed: 0,
          indexed: 0,
          failures: 0,
          saturated: false,
        };
      });
      indexer.tick = tick;
      indexer.start();

      await runWithTenantContext('request-tenant', () =>
        runWithTenantDatabaseScope(db, 'request-tenant', async () => {
          indexer.wake();
          expect(tick).not.toHaveBeenCalled();
        })
      );

      expect(tick).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(0);
      expect(tick).toHaveBeenCalledTimes(1);
      expect(observedScopes).toEqual([{ tenantId: undefined, hasDatabase: false }]);
      await indexer.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  dbTest('does not wake when the surrounding tenant transaction rolls back', async ({ db }) => {
    vi.useFakeTimers();
    try {
      const indexer = new KnowledgeEmbeddingIndexer(db, {
        tenantId: 'bootstrap-tenant',
        random: () => 1,
      });
      const tick = vi.fn(async () => ({
        candidates: 0,
        claimed: 0,
        indexed: 0,
        failures: 0,
        saturated: false,
      }));
      indexer.tick = tick;
      indexer.start();
      await vi.advanceTimersByTimeAsync(0);
      tick.mockClear();

      await expect(
        runWithTenantContext('request-tenant', () =>
          runWithTenantDatabaseScope(db, 'request-tenant', async () => {
            indexer.wake();
            throw new Error('rollback');
          })
        )
      ).rejects.toThrow('rollback');

      await vi.advanceTimersByTimeAsync(0);
      expect(tick).not.toHaveBeenCalled();
      await indexer.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  dbTest('reruns after a wake arrives during an active tick', async ({ db }) => {
    try {
      const indexer = new KnowledgeEmbeddingIndexer(db, {
        tenantId: 'bootstrap-tenant',
        random: () => 1,
      });
      let releaseFirst!: () => void;
      let signalStarted!: () => void;
      let signalSecond!: () => void;
      const firstStarted = new Promise<void>((resolve) => {
        signalStarted = resolve;
      });
      const secondStarted = new Promise<void>((resolve) => {
        signalSecond = resolve;
      });
      const holdFirst = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      let calls = 0;
      const checkOnce = vi.fn(async () => {
        calls += 1;
        if (calls === 1) {
          signalStarted();
          await holdFirst;
        } else {
          signalSecond();
        }
        return {
          candidates: 0,
          claimed: 0,
          indexed: 0,
          failures: 0,
          saturated: false,
        };
      });
      Object.defineProperty(indexer, 'checkOnce', { value: checkOnce });
      indexer.start();

      indexer.wake();
      await firstStarted;
      indexer.wake();
      releaseFirst();
      await secondStarted;

      expect(checkOnce).toHaveBeenCalledTimes(2);
      await indexer.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  dbTest(
    'bounds graceful drain and relies on durable lease recovery after timeout',
    async ({ db }) => {
      vi.useFakeTimers();
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        const indexer = new KnowledgeEmbeddingIndexer(db, {
          tenantId: 'bootstrap-tenant',
          shutdownDrainTimeoutMs: 100,
        });
        let started!: () => void;
        const tickStarted = new Promise<void>((resolve) => {
          started = resolve;
        });
        indexer.tick = vi.fn(async () => {
          started();
          await new Promise<void>(() => undefined);
          return {
            candidates: 0,
            claimed: 0,
            indexed: 0,
            failures: 0,
            saturated: false,
          };
        });
        indexer.start();
        await vi.advanceTimersByTimeAsync(0);
        await tickStarted;

        const stopping = indexer.stop();
        await vi.advanceTimersByTimeAsync(100);
        await expect(stopping).resolves.toBeUndefined();
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('event=shutdown_drain_timeout'));
      } finally {
        warn.mockRestore();
        vi.useRealTimers();
      }
    }
  );
});
