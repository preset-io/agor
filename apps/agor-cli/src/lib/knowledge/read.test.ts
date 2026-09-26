import { PAGINATION } from '@agor/core/config';
import {
  createTenantScopedDatabaseProxy,
  generateId,
  KnowledgeDocumentRepository,
  KnowledgeNamespaceRepository,
  UsersRepository,
} from '@agor/core/db';
import type { User } from '@agor/core/types';
import type { AuthenticatedAgorClient } from '@agor-live/client';
import { describe, expect, it } from 'vitest';
import { dbTest } from '../../../../../packages/core/src/db/test-helpers';
import {
  type KnowledgeDocumentParams,
  KnowledgeDocumentsService,
} from '../../../../agor-daemon/src/services/knowledge-documents';
import { KnowledgeNamespacesService } from '../../../../agor-daemon/src/services/knowledge-namespaces';
import {
  getDocument,
  knowledgeListFlags,
  listDocuments,
  listNamespaces,
  namespaceBySlug,
  page,
  pageSummary,
  renderKnowledgePage,
  table,
} from './read';

// Mirror REST's scalar query encoding instead of passing native booleans.
function restQuery(query: Record<string, unknown> = {}) {
  return Object.fromEntries(
    Object.entries(query).map(([key, value]) => [
      key,
      typeof value === 'boolean' ? String(value) : value,
    ])
  );
}

describe('Knowledge discovery', () => {
  it('shares default flags without mutable flag instances and preserves rendering contracts', () => {
    const flags = knowledgeListFlags();
    expect(flags.limit.default).toBe(PAGINATION.CLI_DEFAULT_LIMIT);
    expect(flags.limit).not.toBe(knowledgeListFlags().limit);
    const result = page(['one', 'two'], 1, 0);
    expect(
      JSON.parse(
        renderKnowledgePage(result, true, ['Name'], () => {
          throw new Error('JSON must not format table rows');
        })
      )
    ).toEqual(result);
    expect(renderKnowledgePage(result, false, ['Name'], (value) => [value])).toBe(
      `${table(['Name'], [['one']])}\n${pageSummary(result)}`
    );
  });

  it('reports bounded display pages, empty results and terminal-safe metadata', () => {
    expect(page([1, 2, 3], 2, 1)).toEqual({ total: 3, limit: 2, offset: 1, data: [2, 3] });
    expect(pageSummary(page([1, 2, 3], 2, 1))).toContain('Showing 2 of 3 (2–3)');
    expect(pageSummary(page([], 2, 0))).toContain('Showing 0 of 0');
    expect(page([1], 2, 8).data).toEqual([]);
    expect(() => page([], 0, 0)).toThrow('--limit');
    expect(() => page([], 1, -1)).toThrow('--offset');
    expect(table(['Title'], [['hi\x1b[2J\nthere']])).toContain('hi\\u001b[2J\\u000athere');
  });

  dbTest(
    'lists authorized current metadata, reads drafts over REST and denies inaccessible data',
    async ({ db }) => {
      const users = new UsersRepository(db);
      const owner = (await users.create({
        email: `${generateId()}@test.invalid`,
        role: 'member',
      })) as User;
      const other = (await users.create({
        email: `${generateId()}@test.invalid`,
        role: 'member',
      })) as User;
      const admin = (await users.create({
        email: `${generateId()}@test.invalid`,
        role: 'admin',
      })) as User;
      const namespaces = new KnowledgeNamespaceRepository(db);
      const ns = await namespaces.create({
        slug: 'synthetic',
        display_name: 'Synthetic',
        owner_user_id: owner.user_id,
        visibility_default: 'private',
        others_can: 'none',
      });
      await namespaces.create({
        slug: 'hidden',
        display_name: 'Hidden',
        owner_user_id: other.user_id,
        others_can: 'none',
      });
      const docs = new KnowledgeDocumentRepository(db);
      const draft = await docs.create({
        namespace_id: ns.namespace_id,
        path: 'nested/draft.md',
        title: '草稿',
        status: 'draft',
        visibility: 'private',
        created_by: owner.user_id,
        content_text: '# Café\r\nこんにちは\n',
      });
      await docs.create({
        namespace_id: ns.namespace_id,
        path: 'index.md',
        title: 'Index',
        visibility: 'private',
        created_by: owner.user_id,
        content_text: '# Index',
      });
      const archived = await docs.create({
        namespace_id: ns.namespace_id,
        path: 'old.md',
        title: 'Old',
        visibility: 'private',
        created_by: owner.user_id,
        content_text: 'old',
      });
      await docs.update(archived.document_id, { archived: true });
      const scoped = createTenantScopedDatabaseProxy(db, { requireScope: false });
      const nsService = new KnowledgeNamespacesService(scoped);
      const docService = new KnowledgeDocumentsService(scoped);
      const clientFor = (user: User) =>
        ({
          service: (path: string) => {
            if (path === 'kb/namespaces')
              return {
                findAll: (params?: { query?: Record<string, unknown> }) =>
                  nsService.find({ user, query: params?.query }),
              };
            if (path === 'kb/documents')
              return {
                // Mirrors the client's findAll(): walk server pages to the total.
                findAll: async (params?: { query?: Record<string, unknown> }) => {
                  const rows = [];
                  let total = Number.POSITIVE_INFINITY;
                  while (rows.length < total) {
                    const page = await docService.find({
                      user,
                      query: restQuery({ ...params?.query, $skip: rows.length }),
                    } as KnowledgeDocumentParams);
                    total = page.total;
                    if (page.data.length === 0) break;
                    rows.push(...page.data);
                  }
                  return rows;
                },
                get: (id: string, params?: { query?: Record<string, unknown> }) =>
                  docService.get(id, {
                    user,
                    query: restQuery(params?.query),
                  } as KnowledgeDocumentParams),
              };
            throw new Error(`Unexpected service ${path}`);
          },
        }) as unknown as AuthenticatedAgorClient;
      const client = clientFor(owner);
      const slugs = (await listNamespaces(client)).map((n) => n.slug);
      expect(slugs).toContain('synthetic');
      expect(slugs).not.toContain('hidden');
      expect(slugs).toEqual([...slugs].sort((a, b) => a.localeCompare(b)));
      expect((await namespaceBySlug(client, 'synthetic')).namespace_id).toBe(ns.namespace_id);
      const listed = await listDocuments(client, 'synthetic');
      expect(listed.map((d) => d.path)).toEqual(['index.md', 'nested/draft.md']);
      expect(listed.every((d) => !('content' in d))).toBe(true);
      expect((await listDocuments(client, 'synthetic', 'draft')).map((d) => d.document_id)).toEqual(
        [draft.document_id]
      );
      // Admin's other-user drafts must not disappear due to REST string booleans.
      expect((await listDocuments(clientFor(admin), 'synthetic')).length).toBe(2);
      expect((await getDocument(client, 'synthetic', 'nested/draft.md')).content).toBe(
        '# Café\r\nこんにちは\n'
      );
      await expect(getDocument(client, 'synthetic', 'old.md')).rejects.toThrow('not found');
      await expect(getDocument(client, 'synthetic', 'missing.md')).rejects.toThrow('not found');
      await expect(namespaceBySlug(client, 'hidden')).rejects.toThrow('not accessible');
      await expect(getDocument(clientFor(other), 'synthetic', 'nested/draft.md')).rejects.toThrow(
        'not accessible'
      );
      await expect(
        docService.get(draft.document_id, { user: other, query: { include_content: true } })
      ).rejects.toThrow('permission');
      await expect(
        docService.find({
          user: owner,
          query: { include_other_user_drafts: 'bad' },
        } as unknown as KnowledgeDocumentParams)
      ).rejects.toThrow('Invalid boolean');
      const metadataOnly = await docService.get(draft.document_id, {
        user: owner,
        query: { include_content: 'false' },
      } as unknown as KnowledgeDocumentParams);
      expect(metadataOnly).not.toHaveProperty('content');
    }
  );
});
