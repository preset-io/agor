/** Real pgvector/RLS and transport coverage; query embeddings are always synthetic. */
import { createClient } from '@agor/core/api';
import {
  acquireTenantWriteGate,
  createDatabase,
  createTenantScopedDatabaseProxy,
  type Database,
  executeRaw,
  generateId,
  initializeDatabase,
  KnowledgeDocumentRepository,
  KnowledgeNamespaceRepository,
  KnowledgeSemanticSettingsRepository,
  releaseTenantWriteGate,
  runWithTenantDatabaseScope,
  sql,
  type TenantScopeAwareDatabase,
  UsersRepository,
} from '@agor/core/db';
import type {
  KnowledgeDocument,
  KnowledgeNamespace,
  KnowledgeSearchResult,
  User,
} from '@agor/core/types';
import type { McpServer } from '@modelcontextprotocol/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { boardMetadataTestApp } from '../../test/board-metadata-app.js';
import { OpenAIEmbeddingProvider } from '../knowledge/embeddings.js';
import { ensureKnowledgePgvectorStorage } from '../knowledge/pgvector.js';
import { ToolDispatcher, toolDispatcherProxy } from '../mcp/register-tool-proxy.js';
import type { McpContext } from '../mcp/server.js';
import { tenantScopedToolProxy } from '../mcp/tenant-scope.js';
import { registerKnowledgeTools } from '../mcp/tools/knowledge.js';
import type { RegisterHooksContext } from '../register-hooks.js';
import { KnowledgeSearchService } from './knowledge-search.js';

const postgresUrl = process.env.AGOR_TEST_POSTGRES_URL;
const dimensions = 1536;
const vector = [1, ...Array<number>(dimensions - 1).fill(0)];
function rows(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value : (value as { rows: Record<string, unknown>[] }).rows;
}
interface Fixture {
  tenant: string;
  owner: User;
  reader: User;
  admin: User;
  namespace: KnowledgeNamespace;
  closed: KnowledgeNamespace;
  documents: Record<string, KnowledgeDocument>;
}

describe.skipIf(!postgresUrl || process.env.AGOR_DB_DIALECT !== 'postgresql')(
  'Knowledge search PostgreSQL/RLS',
  () => {
    let rawDb: Database;
    let db: TenantScopeAwareDatabase;
    let service: KnowledgeSearchService;
    let a: Fixture;
    let b: Fixture;
    let server: Awaited<ReturnType<typeof boardMetadataTestApp>>;
    const embed = vi.spyOn(OpenAIEmbeddingProvider.prototype, 'embed');

    async function seed(): Promise<Fixture> {
      const tenant = `search-${generateId()}`;
      return runWithTenantDatabaseScope(db, tenant, async (scoped) => {
        const users = new UsersRepository(scoped);
        const owner = (await users.create({
          email: `owner-${generateId()}@test.invalid`,
          name: 'Owner',
        })) as User;
        const reader = (await users.create({
          email: `reader-${generateId()}@test.invalid`,
          name: 'Reader',
        })) as User;
        const admin = (await users.create({
          email: `admin-${generateId()}@test.invalid`,
          name: 'Admin',
          role: 'admin',
        })) as User;
        const namespaces = new KnowledgeNamespaceRepository(scoped);
        const namespace = await namespaces.create({
          slug: 'search-fixture',
          display_name: 'Search',
          owner_user_id: owner.user_id,
          others_can: 'read',
        });
        const closed = await namespaces.create({
          slug: 'closed',
          display_name: 'Closed',
          owner_user_id: owner.user_id,
          others_can: 'none',
        });
        const archived = await namespaces.create({
          slug: 'archived',
          display_name: 'Archived',
          owner_user_id: owner.user_id,
          others_can: 'read',
        });
        const docs = new KnowledgeDocumentRepository(scoped);
        const documents: Record<string, KnowledgeDocument> = {};
        await new KnowledgeSemanticSettingsRepository(scoped).patch({
          enabled: true,
          api_key: 'synthetic-never-sent',
          provider: 'openai',
          model: 'text-embedding-3-small',
          dimensions,
        });
        const space = generateId();
        const wrongSpace = generateId();
        for (const [id, model] of [
          [space, 'text-embedding-3-small'],
          [wrongSpace, 'text-embedding-3-large'],
        ]) {
          await executeRaw(
            scoped,
            sql`INSERT INTO kb_embedding_spaces (tenant_id, embedding_space_id, provider, model, dimensions, created_at)
          VALUES (${tenant}, ${id}, 'openai', ${model}, ${dimensions}, now())`
          );
        }
        for (const name of [
          'published',
          'own-draft',
          'other-draft',
          'private',
          'archived',
          'stale',
          'unembedded',
          'wrong-model',
          'closed',
          'archived-namespace',
        ]) {
          const document = await docs.create({
            namespace_id:
              name === 'closed'
                ? closed.namespace_id
                : name === 'archived-namespace'
                  ? archived.namespace_id
                  : namespace.namespace_id,
            path: `${name}/needle.md`,
            title: `Needle ${name}`,
            content_text: `# Needle\n\nSynthetic ${name} content`,
            visibility: name === 'private' ? 'private' : 'public',
            status: name.endsWith('draft') ? 'draft' : 'published',
            kind: 'doc',
            created_by: name === 'own-draft' ? reader.user_id : owner.user_id,
          });
          documents[name] = document;
          if (name !== 'unembedded') {
            await executeRaw(
              scoped,
              sql`INSERT INTO kb_unit_embeddings (tenant_id, unit_id, embedding_space_id, content_sha256, embedding, created_at, updated_at)
            SELECT ${tenant}, unit_id, ${name === 'wrong-model' ? wrongSpace : space}, 'synthetic', ${JSON.stringify(vector)}::vector, now(), now()
            FROM kb_document_units WHERE document_id = ${document.document_id} AND version_id = ${document.current_version_id}`
            );
          }
          if (name === 'stale')
            await docs.update(document.document_id, {
              content_text: '# Needle\n\nA new unembedded current version',
              updated_by: owner.user_id,
            });
          if (name === 'archived') await docs.update(document.document_id, { archived: true });
        }
        await namespaces.update(archived.namespace_id, { archived: true });
        return { tenant, owner, reader, admin, namespace, closed, documents };
      });
    }

    beforeAll(async () => {
      rawDb = createDatabase({ dialect: 'postgresql', url: postgresUrl! });
      await initializeDatabase(rawDb);
      db = createTenantScopedDatabaseProxy(rawDb, {
        requireScope: true,
        label: 'knowledge-search-test',
      });
      expect(
        await runWithTenantDatabaseScope(db, 'setup', ensureKnowledgePgvectorStorage)
      ).toMatchObject({ available: true });
      a = await seed();
      b = await seed();
      service = new KnowledgeSearchService(db);
      server = await boardMetadataTestApp(
        db,
        {
          database: { dialect: 'postgresql' },
          multi_tenancy: { mode: 'required_from_auth', auth_claim: 'tenant_id' },
          execution: {},
        } as RegisterHooksContext['config'],
        true,
        false,
        (app) => {
          app.use('kb/search', new KnowledgeSearchService(db), { methods: ['find', 'create'] });
        }
      );
    }, 60_000);
    beforeEach(() => {
      embed.mockReset().mockImplementation(async (inputs, options) =>
        inputs.map((input) => ({
          id: input.id,
          model: options.model,
          dimensions,
          embedding: vector,
        }))
      );
    });
    afterAll(async () => {
      embed.mockRestore();
      await server?.close();
      await (rawDb as Database & { $client: { end: () => Promise<void> } }).$client.end();
    });
    const search = (
      query: Parameters<KnowledgeSearchService['create']>[0],
      fixture = a,
      user = fixture.reader
    ) =>
      runWithTenantDatabaseScope(db, fixture.tenant, () =>
        service.create({ q: 'needle', mode: 'semantic', ...query }, { user })
      );

    it('uses a non-bypass application role and FORCE RLS on every semantic relation', async () => {
      expect(
        rows(
          await executeRaw(
            rawDb,
            sql`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`
          )
        )[0]
      ).toMatchObject({ rolsuper: false, rolbypassrls: false });
      const tables = rows(
        await executeRaw(
          rawDb,
          sql`SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname IN
      ('kb_documents','kb_namespaces','kb_document_units','kb_unit_embeddings','kb_embedding_spaces')`
        )
      );
      expect(tables).toHaveLength(5);
      for (const table of tables)
        expect(table).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true });
      await expect(
        service.find({ user: a.admin, query: { mode: 'semantic', q: 'needle' } })
      ).rejects.toThrow();
      expect(embed).not.toHaveBeenCalled();
    });

    it.each([
      'private',
      'other-draft',
      'archived',
      'stale',
      'unembedded',
      'wrong-model',
      'closed',
      'archived-namespace',
      'missing',
    ])('does no provider work for ineligible %s candidates', async (path) => {
      expect(await search({ path_prefix: path })).toEqual([]);
      expect(embed).not.toHaveBeenCalled();
    });
    it('intersects requested ID and slug with readable scope and tenant even for admins', async () => {
      for (const user of [a.reader, a.admin]) {
        for (const query of [
          { namespace_id: a.namespace.namespace_id, namespace_slug: 'closed' },
          { namespace_slug: 'nonexistent' },
          { namespace_id: b.namespace.namespace_id },
        ])
          expect(await search(query, a, user)).toEqual([]);
      }
      expect(await search({ namespace_id: a.closed.namespace_id })).toEqual([]);
      expect(embed).not.toHaveBeenCalled();
      // Same ID that failed from A succeeds only in its owning tenant B.
      expect(
        await search({ namespace_id: b.namespace.namespace_id, path_prefix: 'published' }, b)
      ).toHaveLength(1);
      expect(embed).toHaveBeenCalledOnce();
    });
    it('preserves draft, path, kind, status, visibility, and admin archived distinctions', async () => {
      for (const query of [
        { path_prefix: 'own-draft', includeMyDrafts: false },
        { path_prefix: 'published', status: 'draft' as const },
        { path_prefix: 'published', visibility: 'private' as const },
        { path_prefix: 'published', kind: 'guide' as const },
        { path_prefix: 'published/no-child' },
      ])
        expect(await search(query)).toEqual([]);
      expect(embed).not.toHaveBeenCalled();
      expect(await search({ path_prefix: '/own-draft/' })).toHaveLength(1);
      expect(
        await search({ path_prefix: 'other-draft', includeOtherUserDrafts: true })
      ).toHaveLength(1);
      expect(await search({ path_prefix: 'private' }, a, a.admin)).toHaveLength(1);
      embed.mockClear();
      expect(await search({ path_prefix: 'archived', include_archived: true }, a, a.admin)).toEqual(
        []
      );
      expect(
        await search({ path_prefix: 'archived', include_archived: true, mode: 'text' }, a, a.admin)
      ).toHaveLength(1);
      expect(embed).not.toHaveBeenCalled();
    });
    it.each(['text', 'semantic', 'hybrid'] as const)(
      'retains authorized %s projections',
      async (mode) => {
        const [result] = await search({
          path_prefix: 'published',
          mode,
          include_chunks: true,
          include_indexing: true,
        });
        expect(result).toMatchObject({
          document: {
            document_id: a.documents.published.document_id,
            updated_by_user: { status: 'resolved' },
          },
          mode,
        });
        expect(result.document).toHaveProperty('indexing_status');
        if (mode === 'semantic') expect(result.current_version).toBeNull();
        else expect(result.current_version?.content_text).toContain('Synthetic published content');
        if (mode !== 'text')
          expect(result.chunks?.[0]).toMatchObject({
            score: 1,
            content_text: expect.stringContaining('Synthetic published'),
          });
        expect(embed).toHaveBeenCalledTimes(mode === 'text' ? 0 : 1);
      }
    );
    it('applies similarity only after the one necessary provider request', async () => {
      embed.mockResolvedValueOnce([
        {
          id: 'query',
          model: 'text-embedding-3-small',
          dimensions,
          embedding: [0, 1, ...Array<number>(dimensions - 2).fill(0)],
        },
      ]);
      expect(
        await search({ path_prefix: 'published', min_similarity: 0.5, rerank_limit: 5 })
      ).toEqual([]);
      expect(embed).toHaveBeenCalledOnce();
    });
    it('keeps hybrid text hits with no vector and text namespace-ID precedence', async () => {
      const results = await search({ path_prefix: 'unembedded', mode: 'hybrid' });
      expect(results).toHaveLength(1);
      expect(results[0].mode).toBe('hybrid');
      expect(
        await search({
          mode: 'text',
          path_prefix: 'published',
          namespace_id: a.namespace.namespace_id,
          namespace_slug: 'closed',
        })
      ).toHaveLength(1);
      expect(embed).not.toHaveBeenCalled();
    });
    it('retains final ACL checks after provider work', async () => {
      await runWithTenantDatabaseScope(db, a.tenant, async () => {
        embed.mockImplementationOnce(async (inputs, options) => {
          await new KnowledgeNamespaceRepository(db).update(a.namespace.namespace_id, {
            others_can: 'none',
          });
          return inputs.map((input) => ({
            id: input.id,
            model: options.model,
            dimensions,
            embedding: vector,
          }));
        });
        expect(
          await service.find({
            user: a.reader,
            query: { mode: 'semantic', q: 'needle', path_prefix: 'published' },
          })
        ).toEqual([]);
        await new KnowledgeNamespaceRepository(db).update(a.namespace.namespace_id, {
          others_can: 'read',
        });
      });
      expect(embed).toHaveBeenCalledOnce();
    });
    it('exercises registered REST and Socket.IO find/create with signed synthetic auth', async () => {
      const headers = server.headers(a.reader.user_id, a.tenant);
      const unauthenticated = await fetch(`${server.url}/kb/search?q=needle&mode=semantic`);
      expect(unauthenticated.status).toBe(401);
      const socket = createClient(server.url, true, {
        socketAuthentication: { accessToken: headers.authorization.slice(7) },
        ackTimeout: 5000,
      });
      const emitted = vi.fn();
      server.app.service('kb/search').on('created', emitted);
      try {
        const query = {
          q: 'needle',
          mode: 'semantic' as const,
          path_prefix: 'published',
          limit: 5,
        };
        const found = await fetch(
          `${server.url}/kb/search?${new URLSearchParams({ ...query, limit: '5', include_chunks: 'true' })}`,
          { headers }
        );
        expect(found.status).toBe(200);
        expect(await found.json()).toMatchObject([
          { document: { document_id: a.documents.published.document_id } },
        ]);
        const created = await fetch(`${server.url}/kb/search`, {
          method: 'POST',
          headers,
          body: JSON.stringify(query),
        });
        expect(created.status).toBe(201);
        expect(await created.json()).toHaveLength(1);
        expect(await socket.service('kb/search').find({ query })).toHaveLength(1);
        expect(await socket.service('kb/search').create(query)).toHaveLength(1);
        expect(embed).toHaveBeenCalledTimes(4);
        expect(emitted).not.toHaveBeenCalled();
        embed.mockClear();
        for (const invalid of [
          { ...query, q: {} },
          { ...query, min_similarity: 2 },
        ]) {
          const response = await fetch(`${server.url}/kb/search`, {
            method: 'POST',
            headers,
            body: JSON.stringify(invalid),
          });
          expect(response.status).toBe(400);
        }
        const foreign = {
          ...query,
          namespace_id: b.namespace.namespace_id,
          readable_as_admin: true,
          readable_namespace_ids: [b.namespace.namespace_id],
        };
        expect(await socket.service('kb/search').find({ query: foreign })).toEqual([]);
        expect(await socket.service('kb/search').create(foreign)).toEqual([]);
        expect(embed).not.toHaveBeenCalled();
      } finally {
        socket.io.disconnect();
        server.app.service('kb/search').removeListener('created', emitted);
      }
    });
    it('preserves the registered POST freeze gate before provider work', async () => {
      const gate = await acquireTenantWriteGate(rawDb, a.tenant, {
        reason: 'synthetic search test',
      });
      try {
        const response = await fetch(`${server.url}/kb/search`, {
          method: 'POST',
          headers: server.headers(a.reader.user_id, a.tenant),
          body: JSON.stringify({ q: 'needle', mode: 'semantic', path_prefix: 'published' }),
        });
        expect(response.status).toBe(503);
        expect(embed).not.toHaveBeenCalled();
      } finally {
        await releaseTenantWriteGate(rawDb, a.tenant, gate);
      }
    });
    it('routes the registered MCP search handler through the same tenant-scoped service', async () => {
      const dispatcher = new ToolDispatcher();
      const ctx = {
        app: server.app,
        db,
        userId: a.reader.user_id,
        authenticatedUser: a.reader,
        baseServiceParams: {
          provider: 'mcp',
          tenant: { tenant_id: a.tenant },
          authentication: {
            strategy: 'jwt',
            accessToken: server.headers(a.reader.user_id, a.tenant).authorization.slice(7),
          },
        },
      } as unknown as McpContext;
      registerKnowledgeTools(
        tenantScopedToolProxy(
          toolDispatcherProxy({ registerTool() {} } as unknown as McpServer, dispatcher),
          ctx
        ),
        ctx
      );
      const call = async (pathPrefix: string) => {
        const result = (await dispatcher
          .get('agor_kb_search')!
          .handler({ query: 'needle', mode: 'semantic', pathPrefix, limit: 5 })) as {
          content: { text: string }[];
        };
        return JSON.parse(result.content[0].text) as KnowledgeSearchResult[];
      };
      expect(await call('missing')).toEqual([]);
      expect(embed).not.toHaveBeenCalled();
      expect(await call('published')).toMatchObject([
        { document: { document_id: a.documents.published.document_id } },
      ]);
      expect(embed).toHaveBeenCalledOnce();
    });
  }
);
