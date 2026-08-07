import type { TenantScopeAwareDatabase } from '@agor/core/db';
import { describe, expect, it, vi } from 'vitest';
import { dbTest } from '../../../../packages/core/src/db/test-helpers';
import {
  hasExactEmbeddingResultIds,
  KnowledgeEmbeddingBatchProcessor,
} from './knowledge-embedding-batch-processor';

describe('hasExactEmbeddingResultIds', () => {
  it('accepts the exact result set independent of provider order', () => {
    expect(
      hasExactEmbeddingResultIds(['unit-a', 'unit-b'], [{ id: 'unit-b' }, { id: 'unit-a' }])
    ).toBe(true);
  });

  it('rejects duplicate, missing, unknown, and duplicate expected IDs', () => {
    expect(
      hasExactEmbeddingResultIds(['unit-a', 'unit-b'], [{ id: 'unit-a' }, { id: 'unit-a' }])
    ).toBe(false);
    expect(hasExactEmbeddingResultIds(['unit-a', 'unit-b'], [{ id: 'unit-a' }])).toBe(false);
    expect(
      hasExactEmbeddingResultIds(['unit-a', 'unit-b'], [{ id: 'unit-a' }, { id: 'unit-c' }])
    ).toBe(false);
    expect(
      hasExactEmbeddingResultIds(['unit-a', 'unit-a'], [{ id: 'unit-a' }, { id: 'unit-a' }])
    ).toBe(false);
  });
});

describe('KnowledgeEmbeddingBatchProcessor policy gating', () => {
  dbTest('does not probe pgvector storage for a disabled policy', async ({ db }) => {
    const ensureStorage = vi.fn(async () => ({
      available: true,
      extensionInstalled: true,
      extensionAvailable: true,
      storageReady: true,
      reason: null,
      setupHint: null,
    }));
    const processor = new KnowledgeEmbeddingBatchProcessor(db as TenantScopeAwareDatabase, {
      perTenantBatchSize: 1,
      claimLeaseMs: 60_000,
      providerTimeoutMs: 1_000,
      retryBaseMs: 1_000,
      retryMaxMs: 60_000,
      workIdentity: { instanceId: 'test-daemon', bootId: 'test-boot' },
      provider: { id: 'openai', embed: vi.fn() },
      generateClaimToken: () => 'claim-token',
      ensureStorage,
      isShutdownRequested: () => false,
    });

    await expect(processor.processTenantBatch('default', ['unit-a'] as never)).resolves.toEqual({
      claimed: 0,
      indexed: 0,
    });
    expect(ensureStorage).not.toHaveBeenCalled();
  });
});
