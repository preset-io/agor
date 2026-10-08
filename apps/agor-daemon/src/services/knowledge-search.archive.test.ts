import type { SQL, TenantScopeAwareDatabase } from '@agor/core/db';
import { DEFAULT_KNOWLEDGE_SEMANTIC_POLICY, type User } from '@agor/core/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock('@agor/core/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agor/core/db')>()),
  isPostgresDatabaseHandle: () => true,
  executeRaw: mocks.execute,
}));
vi.mock('@agor/core/config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agor/core/config')>()),
  getBaseUrl: async () => null,
}));
vi.mock('../knowledge/pgvector.js', () => ({
  getKnowledgePgvectorCapability: async () => ({ available: true }),
  semanticUnavailableMessage: (reason: string) => reason,
}));

import { KnowledgeNamespaceRepository, KnowledgeSemanticSettingsRepository } from '@agor/core/db';
import { OpenAIEmbeddingProvider } from '../knowledge/embeddings';
import { KnowledgeSearchService } from './knowledge-search';

describe('Knowledge semantic archive filtering', () => {
  beforeEach(() => {
    vi.spyOn(KnowledgeSemanticSettingsRepository.prototype, 'findPolicy').mockResolvedValue({
      ...DEFAULT_KNOWLEDGE_SEMANTIC_POLICY,
      enabled: true,
    });
    vi.spyOn(KnowledgeSemanticSettingsRepository.prototype, 'getApiKey').mockResolvedValue(
      'synthetic-no-provider-call'
    );
    vi.spyOn(KnowledgeNamespaceRepository.prototype, 'findReadableNamespaceIds').mockResolvedValue(
      []
    );
    vi.spyOn(OpenAIEmbeddingProvider.prototype, 'embed').mockResolvedValue([
      {
        id: 'query',
        embedding: new Array(1536).fill(0),
        model: 'text-embedding-3-small',
        dimensions: 1536,
      },
    ]);
    mocks.execute.mockReset();
    mocks.execute.mockResolvedValue([]);
  });

  it.each(['active', 'archived', 'all'] as const)(
    'filters %s in PostgreSQL SQL before LIMIT',
    async (archive_filter) => {
      const service = new KnowledgeSearchService({} as TenantScopeAwareDatabase);
      await service.find({
        user: { role: 'admin' } as User,
        query: { mode: 'semantic', q: 'needle', archive_filter, limit: 1 },
      });
      const chunks = (mocks.execute.mock.calls[0][1] as SQL).queryChunks;
      const text = (chunk: unknown) => ((chunk as { value?: string[] })?.value ?? []).join('');
      const index = chunks.findIndex((chunk) => text(chunk).includes('WHERE ('));
      expect(index).toBeGreaterThan(-1);
      expect(chunks[index + 1]).toBe(archive_filter === 'all');
      expect(chunks[index + 3]).toBe(archive_filter === 'archived');
      const statement = chunks.map(text).join('');
      expect(statement).toContain('AND ns.archived = false');
      expect(statement.indexOf('WHERE')).toBeLessThan(statement.indexOf('LIMIT'));
    }
  );

  it('keeps namespace authorization even when all archives are requested', async () => {
    const service = new KnowledgeSearchService({} as TenantScopeAwareDatabase);
    expect(
      await service.find({
        user: { role: 'member' } as User,
        query: { mode: 'semantic', q: 'needle', archive_filter: 'all' },
      })
    ).toEqual([]);
    expect(mocks.execute).not.toHaveBeenCalled();
  });
});
