import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { __resetConfigCacheForTests, type AgorConfig, saveConfig } from '@agor/core/config';
import type { Database } from '@agor/core/db';
import {
  eq,
  generateId,
  KnowledgeDocumentRepository,
  KnowledgeNamespaceRepository,
  kbDocumentUnits,
  select,
  UsersRepository,
} from '@agor/core/db';
import { BadRequest, Forbidden, NotFound } from '@agor/core/feathers';
import type { KnowledgeDocument, User, UserID } from '@agor/core/types';
import { ROLES } from '@agor/core/types';
import { describe, expect, vi } from 'vitest';
import { dbTest } from '../../../../packages/core/src/db/test-helpers';
import { KnowledgeDocumentsService } from './knowledge-documents';
import { KnowledgeEmbeddingIndexer } from './knowledge-embedding-indexer';
import { KnowledgeGraphService } from './knowledge-graph';
import { KnowledgeIndexingStatusService } from './knowledge-indexing';
import { KnowledgeReindexService } from './knowledge-reindex';
import { KnowledgeSearchService } from './knowledge-search';
import { KnowledgeSettingsService } from './knowledge-settings';
import { KnowledgeVersionsService } from './knowledge-versions';

async function seedUser(
  db: Database,
  label: string,
  role: User['role'] = ROLES.MEMBER
): Promise<User> {
  const users = new UsersRepository(db);
  return users.create({
    user_id: generateId() as UserID,
    email: `${label}-${Date.now()}-${Math.random()}@test.local`,
    name: label,
    role,
  }) as Promise<User>;
}

async function seedNamespace(
  db: Database,
  slug = `kb-${Date.now()}-${Math.random().toString(16).slice(2)}`
) {
  return new KnowledgeNamespaceRepository(db).create({ slug, display_name: slug });
}

async function seedDocument(
  db: Database,
  owner: User,
  overrides: Partial<KnowledgeDocument> & { content_text?: string } = {}
) {
  const namespace = await seedNamespace(
    db,
    `svc-${Date.now()}-${Math.random().toString(16).slice(2)}`
  );
  const documents = new KnowledgeDocumentRepository(db);
  return documents.create({
    namespace_id: namespace.namespace_id,
    path: overrides.path ?? 'page.md',
    title: overrides.title ?? 'Page',
    visibility: overrides.visibility ?? 'public',
    edit_policy: overrides.edit_policy ?? 'owner',
    content_text: overrides.content_text ?? '# Page\n\nBody',
    created_by: owner.user_id as UserID,
  });
}

function params(user: User, query?: Record<string, unknown>) {
  return { user, query } as never;
}

async function withTempConfig<T>(config: AgorConfig, run: () => Promise<T>): Promise<T> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agor-kb-service-test-'));
  const spy = vi.spyOn(os, 'homedir').mockReturnValue(tempDir);
  __resetConfigCacheForTests();
  try {
    await saveConfig(config);
    return await run();
  } finally {
    __resetConfigCacheForTests();
    spy.mockRestore();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

describe('KnowledgeDocumentsService permissions', () => {
  dbTest(
    'enforces private/public read access and owner/admin visibility changes',
    async ({ db }) => {
      const owner = await seedUser(db, 'owner');
      const other = await seedUser(db, 'other');
      const admin = await seedUser(db, 'admin', ROLES.ADMIN);
      const service = new KnowledgeDocumentsService(db);
      const privateDoc = await seedDocument(db, owner, { visibility: 'private' });

      await expect(service.get(privateDoc.document_id, params(other))).rejects.toBeInstanceOf(
        Forbidden
      );
      await expect(service.get(privateDoc.document_id, params(owner))).resolves.toMatchObject({
        document_id: privateDoc.document_id,
      });

      await expect(
        service.patch(privateDoc.document_id, { visibility: 'public' }, params(other))
      ).rejects.toBeInstanceOf(Forbidden);

      await expect(
        service.patch(privateDoc.document_id, { visibility: 'public' }, params(admin))
      ).resolves.toMatchObject({ visibility: 'public' });
    }
  );

  dbTest('allows public edits without allowing governance changes or deletion', async ({ db }) => {
    const owner = await seedUser(db, 'owner');
    const other = await seedUser(db, 'other');
    const service = new KnowledgeDocumentsService(db);
    const publicEditable = await seedDocument(db, owner, {
      visibility: 'public',
      edit_policy: 'public',
      content_text: 'v1',
    });

    const edited = await service.patch(
      publicEditable.document_id,
      { content_text: 'v2', change_summary: 'community edit' },
      params(other)
    );
    expect(edited.current_version_id).not.toBe(publicEditable.current_version_id);

    await expect(
      service.patch(publicEditable.document_id, { edit_policy: 'owner' }, params(other))
    ).rejects.toBeInstanceOf(Forbidden);
    await expect(service.remove(publicEditable.document_id, params(other))).rejects.toBeInstanceOf(
      Forbidden
    );
  });

  dbTest(
    'does not treat private documents with public edit policy as world-editable',
    async ({ db }) => {
      const owner = await seedUser(db, 'owner');
      const other = await seedUser(db, 'other');
      const service = new KnowledgeDocumentsService(db);
      const privateEditable = await seedDocument(db, owner, {
        visibility: 'private',
        edit_policy: 'public',
        content_text: 'v1',
      });

      await expect(
        service.patch(privateEditable.document_id, { content_text: 'v2' }, params(other))
      ).rejects.toBeInstanceOf(Forbidden);
    }
  );

  dbTest(
    'upserts by namespace/path and returns current content for MCP-style get',
    async ({ db }) => {
      const owner = await seedUser(db, 'owner');
      const namespace = await seedNamespace(db, 'mcp-style');
      const service = new KnowledgeDocumentsService(db);

      const created = await service.putDocument(
        {
          namespace_slug: namespace.slug,
          path: 'guide.md',
          content_text: '# Guide\n\nInitial',
          first_line_is_title: true,
        },
        params(owner)
      );
      expect(created.title).toBe('Guide');
      expect(created.uri).toBe('agor://kb/mcp-style/guide.md');

      const updated = await service.putDocument(
        {
          namespace_slug: namespace.slug,
          path: 'guide.md',
          content_text: '# Guide\n\nUpdated',
          expected_version: 1,
        },
        params(owner)
      );
      expect(updated.document_id).toBe(created.document_id);

      const hydrated = await service.getDocument(
        { namespace_slug: namespace.slug, path: 'guide.md', include_content: true },
        params(owner)
      );
      expect('content' in hydrated ? hydrated.content : null).toBe('# Guide\n\nUpdated');
    }
  );

  dbTest(
    'hides archived documents from direct get and recreates same path through upsert',
    async ({ db }) => {
      const owner = await seedUser(db, 'owner');
      const namespace = await seedNamespace(db, 'archive-style');
      const service = new KnowledgeDocumentsService(db);

      const created = await service.putDocument(
        { namespace_slug: namespace.slug, path: 'same.md', content_text: 'old' },
        params(owner)
      );
      await service.remove(created.document_id, params(owner));
      await expect(service.get(created.document_id, params(owner))).rejects.toBeInstanceOf(
        NotFound
      );

      const recreated = await service.putDocument(
        { namespace_slug: namespace.slug, path: 'same.md', content_text: 'new' },
        params(owner)
      );
      expect(recreated.document_id).not.toBe(created.document_id);
    }
  );
});

describe('Knowledge semantic indexing lifecycle', () => {
  dbTest('rejects unsupported providers and normalizes blank API keys', async ({ db }) => {
    await withTempConfig({}, async () => {
      const admin = await seedUser(db, 'admin', ROLES.ADMIN);
      const settings = new KnowledgeSettingsService(db);

      await expect(
        settings.patch(null, { provider: 'voyage' as never }, params(admin))
      ).rejects.toBeInstanceOf(BadRequest);

      const saved = await settings.patch(
        null,
        { enabled: true, provider: 'openai', api_key: '   ' },
        params(admin)
      );
      expect(saved.api_key_configured).toBe(false);
    });
  });

  dbTest('reindex rebuilds chunks from current document content on SQLite', async ({ db }) => {
    await withTempConfig(
      {
        knowledge: {
          semantic_search: {
            enabled: true,
            provider: 'openai',
            chunking: {
              target_tokens: 40,
              max_tokens: 60,
              overlap_tokens: 0,
              min_tokens: 1,
            },
          },
        },
      },
      async () => {
        const owner = await seedUser(db, 'owner');
        const doc = await seedDocument(db, owner, {
          content_text: `# Big\n\n${Array.from({ length: 500 }, (_, i) => `word${i}`).join(' ')}`,
        });

        const result = await new KnowledgeReindexService(db).create();
        expect(result.status).toBe('not_configured');
        expect(result.queued).toBeGreaterThan(1);

        const units = await select(db)
          .from(kbDocumentUnits)
          .where(eq(kbDocumentUnits.version_id, doc.current_version_id))
          .all();
        expect(units).toHaveLength(result.queued);
        expect(new Set(units.map((unit) => unit.embedding_status))).toEqual(
          new Set(['not_configured'])
        );
      }
    );
  });

  dbTest('indexing status separates pgvector extension from usable storage', async ({ db }) => {
    await withTempConfig(
      { knowledge: { semantic_search: { enabled: true, provider: 'openai' } } },
      async () => {
        const status = await new KnowledgeIndexingStatusService(db).find();

        expect(status.pgvector_available).toBe(false);
        expect(status.pgvector_extension_installed).toBe(false);
        expect(status.pgvector_storage_ready).toBe(false);
        expect(status.last_error).toContain('not PostgreSQL');
      }
    );
  });

  dbTest(
    'indexing status hides stale indexer errors when semantic search is disabled',
    async ({ db }) => {
      await withTempConfig({}, async () => {
        const app = {
          get: (key: string) =>
            key === 'knowledgeEmbeddingIndexer'
              ? { getLastError: () => 'old pgvector error', getLastIndexedAt: () => null }
              : undefined,
        } as never;

        const status = await new KnowledgeIndexingStatusService(db, app).find();

        expect(status.enabled).toBe(false);
        expect(status.last_error).toBeNull();
      });
    }
  );

  dbTest(
    'indexer clears stale pgvector errors when semantic indexing is disabled',
    async ({ db }) => {
      await withTempConfig({}, async () => {
        const indexer = new KnowledgeEmbeddingIndexer(db);
        (indexer as unknown as { lastError: string | null }).lastError = 'old pgvector error';

        await expect(indexer.indexBatch()).resolves.toBe(0);
        expect(indexer.getLastError()).toBeNull();
      });
    }
  );

  dbTest(
    'document content writes wake the embedding indexer through the app reference',
    async ({ db }) => {
      await withTempConfig({}, async () => {
        const owner = await seedUser(db, 'owner');
        const doc = await seedDocument(db, owner, { content_text: '# Page\n\nBefore' });
        const wake = vi.fn();
        const app = {
          get: (key: string) => (key === 'knowledgeEmbeddingIndexer' ? { wake } : undefined),
        } as never;
        const service = new KnowledgeDocumentsService(db, app);

        await service.patch(doc.document_id, { content_text: '# Page\n\nAfter' }, params(owner));

        expect(wake).toHaveBeenCalledTimes(1);
      });
    }
  );
});

describe('KnowledgeSearchService and KnowledgeVersionsService permissions', () => {
  dbTest('scopes search results and ignores non-admin include_archived', async ({ db }) => {
    const owner = await seedUser(db, 'owner');
    const other = await seedUser(db, 'other');
    const admin = await seedUser(db, 'admin', ROLES.ADMIN);
    const publicDoc = await seedDocument(db, owner, {
      visibility: 'public',
      path: 'public.md',
      content_text: 'sharedterm public',
    });
    const privateDoc = await seedDocument(db, owner, {
      visibility: 'private',
      path: 'private.md',
      content_text: 'sharedterm private',
    });
    const archivedDoc = await seedDocument(db, owner, {
      visibility: 'public',
      path: 'archived.md',
      content_text: 'archivedterm',
    });
    await new KnowledgeDocumentRepository(db).delete(archivedDoc.document_id);

    const search = new KnowledgeSearchService(db);
    const otherResults = await search.find(params(other, { q: 'sharedterm' }));
    expect(otherResults.map((result) => result.document.document_id)).toEqual([
      publicDoc.document_id,
    ]);

    const ownerResults = await search.find(params(owner, { q: 'sharedterm' }));
    expect(new Set(ownerResults.map((result) => result.document.document_id))).toEqual(
      new Set([publicDoc.document_id, privateDoc.document_id])
    );

    expect(await search.find(params(other, { q: 'archivedterm', include_archived: true }))).toEqual(
      []
    );
    expect(
      (await search.find(params(admin, { q: 'archivedterm', include_archived: true })))[0].document
        .document_id
    ).toBe(archivedDoc.document_id);
  });

  dbTest(
    'hides private and archived history while honoring include_content and limit',
    async ({ db }) => {
      const owner = await seedUser(db, 'owner');
      const other = await seedUser(db, 'other');
      const doc = await seedDocument(db, owner, { visibility: 'private', content_text: 'v1' });
      await new KnowledgeDocumentRepository(db).update(doc.document_id, {
        content_text: 'v2',
        updated_by: owner.user_id as UserID,
      });
      const versions = new KnowledgeVersionsService(db);

      await expect(
        versions.find(params(other, { document_id: doc.document_id }))
      ).rejects.toBeInstanceOf(Forbidden);

      const ownerHistory = await versions.find(
        params(owner, { document_id: doc.document_id, include_content: true, $limit: 1 })
      );
      expect(ownerHistory).toHaveLength(1);
      expect(ownerHistory[0].content_text).toBe('v2');

      const redacted = await versions.find(params(owner, { document_id: doc.document_id }));
      expect(redacted[0].content_text).toBeNull();

      await new KnowledgeDocumentRepository(db).delete(doc.document_id);
      expect(await versions.find(params(owner, { document_id: doc.document_id }))).toEqual([]);
    }
  );
});

describe('KnowledgeGraphService permissions', () => {
  dbTest('prevents linking to private documents the caller cannot write', async ({ db }) => {
    const owner = await seedUser(db, 'owner');
    const other = await seedUser(db, 'other');
    const privateDoc = await seedDocument(db, owner, { visibility: 'private' });
    const graph = new KnowledgeGraphService(db);

    await expect(
      graph.link(
        {
          source: { documentId: privateDoc.document_id },
          target: { externalUri: 'https://example.com/ext', label: 'External' },
          edge_type: 'references',
        },
        params(other)
      )
    ).rejects.toBeInstanceOf(Forbidden);
  });

  dbTest('filters unreadable private neighbors from public graph queries', async ({ db }) => {
    const owner = await seedUser(db, 'owner');
    const other = await seedUser(db, 'other');
    const publicDoc = await seedDocument(db, owner, {
      visibility: 'public',
      edit_policy: 'public',
      path: 'public.md',
    });
    const privateDoc = await seedDocument(db, owner, {
      visibility: 'private',
      path: 'private.md',
    });
    const graph = new KnowledgeGraphService(db);

    await graph.link(
      {
        source: { documentId: publicDoc.document_id },
        target: { documentId: privateDoc.document_id },
        edge_type: 'references',
      },
      params(owner)
    );

    const result = await graph.neighbors(
      { node: { documentId: publicDoc.document_id }, direction: 'both' },
      params(other)
    );
    expect(result.center.document_id).toBe(publicDoc.document_id);
    expect(result.nodes).toEqual([]);
    expect(result.edges).toEqual([]);
  });
});
