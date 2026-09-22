import {
  executeRaw,
  isPostgresDatabaseHandle,
  KnowledgeNamespaceRepository,
  type KnowledgeSearchQuery,
  KnowledgeSearchRepository,
  KnowledgeSemanticSettingsRepository,
  type TenantScopeAwareDatabase,
} from '@agor/core/db';
import { BadRequest } from '@agor/core/feathers';
import type { KnowledgeNamespaceID, User } from '@agor/core/types';
import { beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';
import { OpenAIEmbeddingProvider } from '../knowledge/embeddings.js';
import { getKnowledgePgvectorCapability } from '../knowledge/pgvector.js';
import { KnowledgeSearchService } from './knowledge-search.js';

vi.mock('@agor/core/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agor/core/db')>()),
  executeRaw: vi.fn(),
  isPostgresDatabaseHandle: vi.fn(() => true),
}));
vi.mock('../knowledge/pgvector.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../knowledge/pgvector.js')>()),
  getKnowledgePgvectorCapability: vi.fn(),
}));

const member = { user_id: 'reader', role: 'member' } as User;
const admin = { user_id: 'admin', role: 'admin' } as User;
const namespaceId = 'readable' as KnowledgeNamespaceID;

describe('Knowledge search preparation', () => {
  let service: KnowledgeSearchService;
  let embed: MockInstance<OpenAIEmbeddingProvider['embed']>;

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.mocked(executeRaw).mockReset().mockResolvedValue({ rows: [] });
    vi.mocked(isPostgresDatabaseHandle).mockReturnValue(true);
    vi.mocked(getKnowledgePgvectorCapability).mockResolvedValue({
      available: true,
      extensionInstalled: true,
      extensionAvailable: true,
      storageReady: true,
      reason: null,
      setupHint: null,
    });
    vi.spyOn(KnowledgeNamespaceRepository.prototype, 'findReadableNamespaceIds').mockResolvedValue([
      namespaceId,
    ]);
    vi.spyOn(KnowledgeSemanticSettingsRepository.prototype, 'findPolicy').mockResolvedValue({
      enabled: true,
      provider: 'openai',
      model: 'text-embedding-3-small',
      dimensions: 1536,
    } as Awaited<ReturnType<KnowledgeSemanticSettingsRepository['findPolicy']>>);
    vi.spyOn(KnowledgeSemanticSettingsRepository.prototype, 'getApiKey').mockResolvedValue('fake');
    embed = vi
      .spyOn(OpenAIEmbeddingProvider.prototype, 'embed')
      .mockRejectedValue(new Error('fake provider reached'));
    vi.spyOn(KnowledgeSearchRepository.prototype, 'search').mockResolvedValue([]);
    service = new KnowledgeSearchService({} as TenantScopeAwareDatabase);
  });

  const search = (
    service: KnowledgeSearchService,
    method: 'find' | 'create',
    query: unknown,
    user = member
  ) =>
    method === 'find'
      ? service.find({ user, query: query as KnowledgeSearchQuery })
      : service.create(query as KnowledgeSearchQuery, { user });

  describe.each(['find', 'create'] as const)('%s', (method) => {
    it('ignores forged scope and returns empty without provider work for no readable namespaces', async () => {
      vi.mocked(KnowledgeNamespaceRepository.prototype.findReadableNamespaceIds).mockResolvedValue(
        []
      );
      expect(
        await search(service, method, {
          q: 'needle',
          mode: 'semantic',
          readable_as_admin: true,
          readable_by_user_id: 'someone-else',
          readable_namespace_ids: ['forged'],
        })
      ).toEqual([]);
      expect(embed).not.toHaveBeenCalled();
      expect(executeRaw).not.toHaveBeenCalled();
    });

    it.each(['semantic', 'hybrid'])(
      'skips provider work when %s has no eligible vector',
      async (mode) => {
        expect(
          await search(service, method, { q: 'needle', mode, namespace_slug: 'missing' })
        ).toEqual([]);
        expect(executeRaw).toHaveBeenCalledOnce();
        expect(embed).not.toHaveBeenCalled();
      }
    );

    it.each([
      { q: 4 },
      { q: [] },
      { mode: 'unknown' },
      { path_prefix: {} },
      { path_prefix: '../escape' },
      { min_similarity: 2 },
      { min_similarity: 'NaN' },
      { min_similarity: [] },
      { limit: 'bad' },
      { limit: Infinity },
      { offset: {} },
      { rerank_limit: NaN },
      { namespace_slug: [] },
      { include_chunks: {} },
      { includeMyDrafts: [] },
      { include_indexing: 'bad' },
    ])('rejects malformed fields before provider I/O: %j', async (invalid) => {
      await expect(
        search(service, method, { q: 'needle', mode: 'semantic', ...invalid })
      ).rejects.toBeInstanceOf(BadRequest);
      expect(embed).not.toHaveBeenCalled();
    });

    it('returns blank queries without provider work but still checks configuration', async () => {
      expect(await search(service, method, { q: '  ', mode: 'semantic' })).toEqual([]);
      expect(embed).not.toHaveBeenCalled();
      expect(executeRaw).not.toHaveBeenCalled();
    });

    it('preserves configuration failures with empty scope', async () => {
      vi.mocked(KnowledgeNamespaceRepository.prototype.findReadableNamespaceIds).mockResolvedValue(
        []
      );
      vi.mocked(KnowledgeSemanticSettingsRepository.prototype.findPolicy).mockResolvedValue({
        enabled: false,
      } as never);
      await expect(search(service, method, { q: 'needle', mode: 'semantic' })).rejects.toThrow(
        'disabled'
      );
      expect(embed).not.toHaveBeenCalled();
    });

    it('keeps admin scope unrestricted and makes one provider attempt for an eligible candidate', async () => {
      vi.mocked(executeRaw).mockResolvedValue({ rows: [{ eligible: 1 }] });
      await expect(
        search(service, method, { q: ' needle ', mode: 'semantic' }, admin)
      ).rejects.toThrow('fake provider reached');
      expect(
        KnowledgeNamespaceRepository.prototype.findReadableNamespaceIds
      ).not.toHaveBeenCalled();
      expect(embed).toHaveBeenCalledExactlyOnceWith(
        [{ id: 'query', text: 'needle', inputType: 'query' }],
        { apiKey: 'fake', model: 'text-embedding-3-small', dimensions: 1536 }
      );
    });
  });

  it.each([
    [{ provider: 'unsupported' }, 'Only OpenAI'],
    [{ model: 'unsupported' }, 'Unsupported OpenAI embedding model'],
    [{ dimensions: 3 }, '1536-dimensional'],
  ])('preserves policy errors even when no candidate exists: %j', async (patch, message) => {
    vi.mocked(KnowledgeSemanticSettingsRepository.prototype.findPolicy).mockResolvedValue({
      enabled: true,
      provider: 'openai',
      model: 'text-embedding-3-small',
      dimensions: 1536,
      ...patch,
    } as Awaited<ReturnType<KnowledgeSemanticSettingsRepository['findPolicy']>>);
    await expect(
      service.create({ q: 'needle', mode: 'semantic' }, { user: member })
    ).rejects.toThrow(message);
    expect(embed).not.toHaveBeenCalled();
  });
  it('preserves missing key errors for empty scope', async () => {
    vi.mocked(KnowledgeNamespaceRepository.prototype.findReadableNamespaceIds).mockResolvedValue(
      []
    );
    vi.mocked(KnowledgeSemanticSettingsRepository.prototype.getApiKey).mockResolvedValue(null);
    await expect(service.create({ mode: 'semantic' }, { user: member })).rejects.toThrow(
      'API key is not configured'
    );
    expect(embed).not.toHaveBeenCalled();
  });

  it('preserves capability failures before empty-scope short circuit', async () => {
    vi.mocked(isPostgresDatabaseHandle).mockReturnValue(false);
    await expect(service.find({ user: member, query: { mode: 'semantic' } })).rejects.toMatchObject(
      { data: { code: 'semantic_unavailable' } }
    );
    vi.mocked(isPostgresDatabaseHandle).mockReturnValue(true);
    vi.mocked(getKnowledgePgvectorCapability).mockResolvedValue({
      available: false,
      reason: 'no vector',
    } as never);
    await expect(service.create({ mode: 'hybrid' }, { user: member })).rejects.toMatchObject({
      data: { code: 'semantic_unavailable', reason: 'no vector' },
    });
    expect(embed).not.toHaveBeenCalled();
  });

  it('accepts serialized REST flags without changing their existing interpretation', async () => {
    await service.create(
      {
        q: '',
        include_my_drafts: 'false',
        include_chunks: 'true',
      } as unknown as KnowledgeSearchQuery,
      { user: member }
    );
    expect(KnowledgeSearchRepository.prototype.search).toHaveBeenCalledWith(
      expect.objectContaining({ include_my_drafts: 'false', include_chunks: 'true' })
    );
    expect(embed).not.toHaveBeenCalled();
  });

  it('keeps text browsing provider-free and normalizes numeric strings and draft aliases', async () => {
    await service.create(
      {
        q: '',
        limit: '20',
        offset: '2',
        includeMyDrafts: false,
        includeOtherUserDrafts: true,
      } as unknown as KnowledgeSearchQuery,
      { user: member }
    );
    expect(KnowledgeSearchRepository.prototype.search).toHaveBeenCalledWith(
      expect.objectContaining({
        q: '',
        limit: 20,
        offset: 2,
        mode: 'text',
        include_my_drafts: false,
        include_other_user_drafts: true,
        readable_namespace_ids: [namespaceId],
        readable_as_admin: false,
      })
    );
    expect(embed).not.toHaveBeenCalled();
    expect(getKnowledgePgvectorCapability).not.toHaveBeenCalled();
  });
});
