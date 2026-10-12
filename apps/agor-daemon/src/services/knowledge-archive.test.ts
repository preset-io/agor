import {
  type Database,
  eq,
  generateId,
  KnowledgeDocumentRepository,
  KnowledgeNamespaceRepository,
  kbDocuments,
  UsersRepository,
  update,
} from '@agor/core/db';
import { BadRequest, Conflict, Forbidden, NotFound } from '@agor/core/feathers';
import type { HydratedKnowledgeDocument, KnowledgeArchiveFilter, User } from '@agor/core/types';
import { ROLES } from '@agor/core/types';
import { describe, expect } from 'vitest';
import { dbTest } from '../../../../packages/core/src/db/test-helpers';
import { KnowledgeDocumentsService } from './knowledge-documents';
import { KnowledgeGraphService } from './knowledge-graph';
import { KnowledgeSearchService } from './knowledge-search';
import { KnowledgeVersionsService } from './knowledge-versions';

async function fixture(db: Database) {
  const users = new UsersRepository(db);
  const owner = (await users.create({
    email: `owner-${generateId()}@test.local`,
    name: 'Owner',
    role: ROLES.MEMBER,
  })) as User;
  const other = (await users.create({
    email: `other-${generateId()}@test.local`,
    name: 'Other',
    role: ROLES.MEMBER,
  })) as User;
  const namespaces = new KnowledgeNamespaceRepository(db);
  const namespace = await namespaces.create({
    slug: 'archive-test',
    display_name: 'Archive test',
    owner_user_id: owner.user_id,
    others_can: 'write',
  });
  const documents = new KnowledgeDocumentsService(db);
  const create = (path: string, visibility: 'public' | 'private' = 'public') =>
    documents.putDocument(
      {
        namespace_slug: namespace.slug,
        path,
        content_text: `# Needle ${path}`,
        visibility,
        edit_policy: 'public',
      },
      { user: owner }
    );
  return { owner, other, namespace, namespaces, documents, create };
}

describe('Knowledge document archival', () => {
  dbTest(
    'is reversible and idempotent without changing identity, governance, content, history or ACLs',
    async ({ db }) => {
      const { owner, other, namespace, namespaces, documents, create } = await fixture(db);
      const doc = await create('history.md', 'private');
      const updated = await documents.putDocument(
        { document_id: doc.document_id, content_text: '# Second', expected_version: 1 },
        { user: owner }
      );
      const versions = new KnowledgeVersionsService(db);
      const history = await versions.find({
        user: owner,
        query: { document_id: doc.document_id, include_content: true },
      });
      await namespaces.upsertNamespaceAclEntry({
        namespace_id: namespace.namespace_id,
        subject_type: 'user',
        subject_id: other.user_id,
        permission: 'read',
        created_by: owner.user_id,
      });
      const acl = await namespaces.listNamespaceAcl(namespace.namespace_id);
      const archived = await documents.patch(
        doc.document_id,
        { archived: true, expected_version: 2, expected_archived: false },
        { user: owner }
      );
      expect(archived).toMatchObject({
        archived: true,
        current_version_id: updated.current_version_id,
        created_by: doc.created_by,
        edit_policy: doc.edit_policy,
        visibility: 'private',
        metadata: doc.metadata,
      });
      expect(archived.archived_at).toBeInstanceOf(Date);
      expect(await documents.remove(doc.document_id, { user: owner })).toEqual(archived);
      // Lost acknowledgements can be retried with the old state guard.
      expect(
        await documents.patch(
          doc.document_id,
          { archived: true, expected_archived: false, expected_version: 1 },
          { user: owner }
        )
      ).toEqual(archived);
      const direct = (await documents.getDocument(
        { namespace: namespace.slug, path: doc.path, include_content: true },
        { user: owner }
      )) as HydratedKnowledgeDocument;
      expect(direct).toMatchObject({ archived: true, content: '# Second' });
      expect(
        await versions.find({
          user: owner,
          query: { document_id: doc.document_id, include_content: true },
        })
      ).toEqual(history);
      const restored = await documents.patch(doc.document_id, { archived: false }, { user: owner });
      expect(restored).toMatchObject({
        document_id: doc.document_id,
        archived: false,
        archived_at: null,
        current_version_id: updated.current_version_id,
      });
      expect(await documents.patch(doc.document_id, { archived: false }, { user: owner })).toEqual(
        restored
      );
      expect(await namespaces.listNamespaceAcl(namespace.namespace_id)).toEqual(acl);
      expect(
        await versions.find({
          user: owner,
          query: { document_id: doc.document_id, include_content: true },
        })
      ).toEqual(history);
    }
  );

  dbTest(
    'filters SQL pages and totals and text-search offsets before pagination for authorized readers',
    async ({ db }) => {
      const { owner, other, documents, create } = await fixture(db);
      const docs = [];
      for (let i = 0; i < 6; i++) {
        const doc = await create(`${i}.md`);
        docs.push(doc);
        if (i % 2) await documents.patch(doc.document_id, { archived: true }, { user: owner });
      }
      const privateDoc = await create('private.md', 'private');
      await documents.patch(privateDoc.document_id, { archived: true }, { user: owner });
      for (const [archive_filter, total] of [
        ['active', 3],
        ['archived', 3],
        ['all', 6],
      ] as const) {
        const result = await documents.find({
          user: other,
          query: { archive_filter, $limit: 1, $skip: 1, $sort: { path: 1 } },
        });
        expect(result.total).toBe(total);
        expect(result.data).toHaveLength(1);
        expect(result.data[0].path).toBe(
          archive_filter === 'active' ? '2.md' : archive_filter === 'archived' ? '3.md' : '1.md'
        );
        expect(
          (await documents.find({ user: other, query: { archive_filter, $limit: 0 } })).total
        ).toBe(total);
        const search = new KnowledgeSearchService(db);
        const full = await search.find({
          user: other,
          query: { archive_filter, q: 'Needle', limit: 100 },
        });
        const page = await search.find({
          user: other,
          query: { archive_filter, q: 'Needle', limit: 1, offset: 1 },
        });
        expect(full).toHaveLength(total);
        expect(page.map((row) => row.document.document_id)).toEqual([full[1].document.document_id]);
      }
      expect((await documents.find({ user: other })).total).toBe(3);
      expect(await documents.find({ user: other, query: { archived: true } })).toMatchObject({
        total: 3,
      });
      await expect(
        documents.find({
          user: other,
          query: { archive_filter: 'invalid' as KnowledgeArchiveFilter },
        })
      ).rejects.toBeInstanceOf(BadRequest);
      expect(
        await new KnowledgeSearchService(db).find({
          user: other,
          query: { include_archived: 'true' as unknown as boolean },
        })
      ).toHaveLength(6);
    }
  );

  dbTest(
    'preserves namespace and document gates on direct reads, archive and restore',
    async ({ db }) => {
      const { owner, other, namespace, namespaces, documents, create } = await fixture(db);
      const doc = await create('public.md');
      // A public editor is not a document owner.
      await expect(
        documents.patch(doc.document_id, { archived: true }, { user: other })
      ).rejects.toBeInstanceOf(Forbidden);
      await documents.patch(doc.document_id, { archived: true }, { user: owner });
      expect(await documents.get(doc.document_id, { user: other })).toMatchObject({
        archived: true,
      });
      await expect(
        documents.patch(doc.document_id, { archived: false }, { user: other })
      ).rejects.toBeInstanceOf(Forbidden);
      const privateDoc = await create('private.md', 'private');
      await documents.patch(privateDoc.document_id, { archived: true }, { user: owner });
      await expect(documents.get(privateDoc.document_id, { user: other })).rejects.toBeInstanceOf(
        Forbidden
      );
      await namespaces.update(namespace.namespace_id, { others_can: 'none' });
      await expect(documents.get(doc.document_id, { user: other })).rejects.toBeInstanceOf(
        Forbidden
      );
      expect((await documents.find({ user: other, query: { archive_filter: 'all' } })).total).toBe(
        0
      );
      // Even the document's author needs namespace write permission.
      await namespaces.update(namespace.namespace_id, { owner_user_id: other.user_id });
      await expect(
        documents.patch(doc.document_id, { archived: false }, { user: owner })
      ).rejects.toBeInstanceOf(Forbidden);
      await expect(
        documents.patch(generateId(), { archived: false }, { user: owner })
      ).rejects.toBeInstanceOf(NotFound);
    }
  );

  dbTest(
    'rejects stale guards, mixed archive/content patches, and implicit restore/path replacement',
    async ({ db }) => {
      const { owner, namespace, documents, create } = await fixture(db);
      const doc = await create('reserved.md');
      await documents.putDocument(
        { document_id: doc.document_id, content_text: '# New' },
        { user: owner }
      );
      await expect(
        documents.patch(doc.document_id, { archived: true, expected_version: 1 }, { user: owner })
      ).rejects.toBeInstanceOf(Conflict);
      await expect(
        documents.patch(
          doc.document_id,
          { archived: true, expected_archived: true },
          { user: owner }
        )
      ).rejects.toBeInstanceOf(Conflict);
      await expect(
        documents.patch(doc.document_id, { archived: true, content_text: 'mixed' }, { user: owner })
      ).rejects.toBeInstanceOf(BadRequest);
      await documents.patch(doc.document_id, { archived: true }, { user: owner });
      await expect(
        documents.putDocument(
          { namespace_slug: namespace.slug, path: doc.path, content_text: 'replacement' },
          { user: owner }
        )
      ).rejects.toBeInstanceOf(Conflict);
      await expect(
        documents.patch(doc.document_id, { content_text: 'replacement' }, { user: owner })
      ).rejects.toBeInstanceOf(Conflict);
      await expect(
        new KnowledgeDocumentRepository(db).create({
          namespace_id: namespace.namespace_id,
          path: doc.path,
          content_text: 'duplicate',
        })
      ).rejects.toThrow('reserved');
      await expect(
        documents.create(
          { namespace_id: namespace.namespace_id, path: doc.path, content_text: 'duplicate' },
          { user: owner }
        )
      ).rejects.toBeInstanceOf(Conflict);
      expect((await documents.find({ user: owner, query: { archive_filter: 'all' } })).total).toBe(
        1
      );
      await documents.patch(doc.document_id, { archived: false }, { user: owner });
      expect(
        (
          await documents.putDocument(
            { namespace_slug: namespace.slug, path: doc.path, content_text: '# Restored edit' },
            { user: owner }
          )
        ).document_id
      ).toBe(doc.document_id);
    }
  );

  dbTest(
    'keeps legacy occupied-path restores safe and namespace archives out of document discovery',
    async ({ db }) => {
      const { owner, namespace, namespaces, documents, create } = await fixture(db);
      const old = await create('old.md');
      const current = await create('current.md');
      await documents.patch(old.document_id, { archived: true }, { user: owner });
      // Disposable legacy fixture: old releases allowed active replacement of archived paths.
      await update(db, kbDocuments)
        .set({ path: old.path, uri: old.uri })
        .where(eq(kbDocuments.document_id, current.document_id))
        .run();
      await expect(
        documents.patch(old.document_id, { archived: false }, { user: owner })
      ).rejects.toBeInstanceOf(Conflict);
      expect(await documents.get(old.document_id, { user: owner })).toMatchObject({
        archived: true,
      });
      await namespaces.delete(namespace.namespace_id);
      expect((await documents.find({ user: owner, query: { archive_filter: 'all' } })).total).toBe(
        0
      );
      await expect(documents.get(old.document_id, { user: owner })).rejects.toBeInstanceOf(
        NotFound
      );
      await expect(
        documents.patch(old.document_id, { archived: false }, { user: owner })
      ).rejects.toThrow();
    }
  );

  dbTest(
    'hides archived documents from namespace graphs without deleting their reference history',
    async ({ db }) => {
      const { owner, namespace, documents, create } = await fixture(db);
      const target = await create('target.md');
      const source = await create('source.md');
      await documents.putDocument(
        {
          document_id: source.document_id,
          content_text: `[target](agor://kb/document/${target.document_id})`,
        },
        { user: owner }
      );
      const graph = new KnowledgeGraphService(db);
      const before = await graph.namespaceGraph({ namespace: namespace.slug }, { user: owner });
      expect(before.edges).toHaveLength(1);
      await documents.patch(target.document_id, { archived: true }, { user: owner });
      const archived = await graph.namespaceGraph({ namespace: namespace.slug }, { user: owner });
      expect(archived.nodes.some((node) => node.document_id === target.document_id)).toBe(false);
      await documents.patch(target.document_id, { archived: false }, { user: owner });
      const restored = await graph.namespaceGraph({ namespace: namespace.slug }, { user: owner });
      expect(restored.edges.map((edge) => edge.edge_id)).toEqual(
        before.edges.map((edge) => edge.edge_id)
      );
      expect(restored.nodes.some((node) => node.document_id === target.document_id)).toBe(true);
    }
  );
});
