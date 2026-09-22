import {
  createTenantScopedDatabaseProxy,
  generateId,
  KnowledgeDocumentRepository,
  KnowledgeDocumentVersionRepository,
  KnowledgeNamespaceRepository,
  UsersRepository,
} from '@agor/core/db';
import { transferSha256 } from '@agor/core/knowledge';
import type { KnowledgeTransferEntry, User, UserID } from '@agor/core/types';
import { ROLES } from '@agor/core/types';
import { describe, expect, vi } from 'vitest';
import { dbTest } from '../../../../packages/core/src/db/test-helpers';
import { KnowledgeTransfersService } from './knowledge-transfers';

const bundle = 'a'.repeat(64);
const entry: KnowledgeTransferEntry = {
  key: 'd000001',
  path: 'guide.md',
  title: 'Guide',
  icon_emoji: null,
  kind: 'guide',
  status: 'draft',
  sha256: transferSha256('# hello'),
  bytes: 7,
  frontmatter: { tags: ['test'] },
  provenance: { visibility: 'public', created_by: 'foreign', metadata: { dangerous: true } },
};
async function user(
  db: ConstructorParameters<typeof UsersRepository>[0],
  role: User['role'] = ROLES.MEMBER
) {
  return new UsersRepository(db).create({
    user_id: generateId() as UserID,
    email: `${generateId()}@test.invalid`,
    name: 'Synthetic',
    role,
  }) as Promise<User>;
}

describe('Knowledge transfers', () => {
  dbTest(
    'private create, hash-only inventory, replay and archived-target conflict',
    async ({ db }) => {
      const owner = await user(db);
      const stranger = await user(db);
      const admin = await user(db, ROLES.ADMIN);
      const service = new KnowledgeTransfersService(
        createTenantScopedDatabaseProxy(db, { requireScope: false })
      );
      const request = {
        action: 'namespace',
        bundle,
        slug: 'migrated',
        display_name: 'Migrated',
        description: null,
        resume: false,
      };
      const ns = await service.create(request, { user: owner });
      const first = await service.create(
        { action: 'document', bundle, slug: 'migrated', entry, content: '# hello' },
        { user: owner }
      );
      expect(first.skipped).toBe(false);
      const doc = await new KnowledgeDocumentRepository(db).findById(first.target_id);
      expect(doc).toMatchObject({
        created_by: owner.user_id,
        visibility: 'private',
        edit_policy: 'owner',
        status: 'draft',
      });
      expect(doc?.metadata).not.toHaveProperty('dangerous');
      expect(
        await service.create(
          { action: 'document', bundle, slug: 'migrated', entry, content: '# hello' },
          { user: owner }
        )
      ).toEqual({ ...first, skipped: true });
      expect(
        await new KnowledgeDocumentVersionRepository(db).findAll({ document_id: doc!.document_id })
      ).toHaveLength(1);
      await expect(
        service.find({ user: stranger, query: { namespace: 'migrated', bundle } })
      ).rejects.toThrow();
      await expect(service.find({ user: owner, query: { namespace: 'migrated' } })).rejects.toThrow(
        'admin'
      );
      const page = await service.find({ user: admin, query: { namespace: 'migrated' } });
      expect(page.total).toBe(1);
      expect(page.entries[0]).toMatchObject({ sha256: entry.sha256, bytes: 7, status: 'draft' });
      expect(JSON.stringify(page)).not.toContain('# hello');
      expect(page.entries[0]).not.toHaveProperty('content_text');
      await service.create(
        { action: 'reconcile', bundle, slug: 'migrated', key: entry.key },
        { user: owner }
      );
      await new KnowledgeDocumentRepository(db).delete(first.target_id);
      await expect(
        service.create(
          { action: 'document', bundle, slug: 'migrated', entry, content: '# hello' },
          { user: owner }
        )
      ).rejects.toThrow('changed');
      expect((await new KnowledgeNamespaceRepository(db).findById(ns.target_id))?.others_can).toBe(
        'none'
      );
    }
  );
  dbTest(
    'does not write on read planning; rejects hash mismatches and changes to imported metadata',
    async ({ db }) => {
      const owner = await user(db);
      const service = new KnowledgeTransfersService(
        createTenantScopedDatabaseProxy(db, { requireScope: false })
      );
      expect(
        (await service.find({ user: owner, query: { namespace: 'new', bundle } })).namespace
      ).toBeNull();
      expect(await new KnowledgeNamespaceRepository(db).findBySlug('new')).toBeNull();
      await service.create(
        {
          action: 'namespace',
          bundle,
          slug: 'new',
          display_name: 'New',
          description: null,
          resume: false,
        },
        { user: owner }
      );
      await expect(
        service.create(
          { action: 'document', bundle, slug: 'new', entry, content: 'wrong' },
          { user: owner }
        )
      ).rejects.toThrow('Content');
      const created = await service.create(
        { action: 'document', bundle, slug: 'new', entry, content: '# hello' },
        { user: owner }
      );
      await new KnowledgeDocumentRepository(db).update(created.target_id, { title: 'Edited' });
      const page = await service.find({ user: owner, query: { namespace: 'new', bundle } });
      expect(page.receipts[0].unchanged).toBe(false);
      await expect(
        service.create(
          { action: 'reconcile', bundle, slug: 'new', key: entry.key },
          { user: owner }
        )
      ).rejects.toThrow('changed');
    }
  );
});

describe('Knowledge transfer inventory and admission', () => {
  dbTest(
    'keyset-pages all drafts without selecting bodies and has exact totals',
    async ({ db }) => {
      const admin = await user(db, ROLES.ADMIN);
      const ns = await new KnowledgeNamespaceRepository(db).create({
        slug: 'paged.source',
        display_name: 'Paged',
        owner_user_id: admin.user_id,
      });
      const docs = new KnowledgeDocumentRepository(db);
      for (let i = 0; i < 101; i++)
        await docs.create({
          namespace_id: ns.namespace_id,
          path: `p${i}.md`,
          content_text: 'Synthetic inventory body',
          status: i % 2 ? 'draft' : 'published',
          visibility: 'private',
          created_by: admin.user_id,
        });
      const client = (
        db as unknown as { $client: { execute: (...args: unknown[]) => Promise<unknown> } }
      ).$client;
      const execute = vi.spyOn(client, 'execute');
      const service = new KnowledgeTransfersService(
        createTenantScopedDatabaseProxy(db, { requireScope: false })
      );
      const first = await service.find({ user: admin, query: { namespace: ns.slug } });
      const second = await service.find({
        user: admin,
        query: { namespace: ns.slug, cursor: first.next_cursor },
      });
      expect(first.total).toBe(101);
      expect(first.entries).toHaveLength(100);
      expect(second.entries).toHaveLength(1);
      expect(second.next_cursor).toBeNull();
      expect(
        new Set([...first.entries, ...second.entries].map((doc) => doc.document_id)).size
      ).toBe(101);
      const statements = execute.mock.calls.map(([query]) =>
        typeof query === 'string' ? query : ((query as { sql?: string }).sql ?? '')
      );
      expect(statements.length).toBeGreaterThan(0);
      expect(statements.join('\n')).not.toContain('"content_text"');
      expect(statements.join('\n')).not.toContain('"content_blob"');
      execute.mockRestore();
    }
  );
  dbTest(
    'serializes duplicate namespace/document requests and keeps only one version',
    async ({ db }) => {
      const owner = await user(db);
      const service = new KnowledgeTransfersService(
        createTenantScopedDatabaseProxy(db, { requireScope: false })
      );
      const request = {
        action: 'namespace',
        bundle,
        slug: 'concurrent',
        display_name: 'Concurrent',
        description: null,
        resume: true,
      };
      const namespaces = await Promise.all([
        service.create(request, { user: owner }),
        service.create(request, { user: owner }),
      ]);
      expect(namespaces[0].target_id).toBe(namespaces[1].target_id);
      const write = { action: 'document', bundle, slug: 'concurrent', entry, content: '# hello' };
      const documents = await Promise.all([
        service.create(write, { user: owner }),
        service.create(write, { user: owner }),
      ]);
      expect(documents[0].target_id).toBe(documents[1].target_id);
      expect(documents.filter((doc) => !doc.skipped)).toHaveLength(1);
    }
  );
});
