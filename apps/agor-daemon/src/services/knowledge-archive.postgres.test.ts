import {
  createDatabase,
  createTenantScopedDatabaseProxy,
  type Database,
  executeRaw,
  generateId,
  initializeDatabase,
  isPostgresDatabase,
  KnowledgeNamespaceRepository,
  runWithTenantDatabaseScope,
  sql,
  type TenantScopeAwareDatabase,
  UsersRepository,
} from '@agor/core/db';
import { Conflict, NotFound } from '@agor/core/feathers';
import type { User } from '@agor/core/types';
import { ROLES } from '@agor/core/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { KnowledgeDocumentsService } from './knowledge-documents';
import { KnowledgeSearchService } from './knowledge-search';
import { KnowledgeVersionsService } from './knowledge-versions';

const url = process.env.AGOR_TEST_POSTGRES_URL;

describe.skipIf(!url || process.env.AGOR_DB_DIALECT !== 'postgresql')(
  'Knowledge archival PostgreSQL/RLS',
  () => {
    let rawDb: Database;
    let db: TenantScopeAwareDatabase;
    beforeAll(async () => {
      rawDb = createDatabase({ dialect: 'postgresql', url: url! });
      await initializeDatabase(rawDb);
      if (!isPostgresDatabase(rawDb)) throw new Error('Requires PostgreSQL');
      const result = await executeRaw(
        rawDb,
        sql`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`
      );
      const rows = Array.isArray(result) ? result : (result as { rows: unknown[] }).rows;
      expect(rows[0]).toMatchObject({ rolsuper: false, rolbypassrls: false });
      db = createTenantScopedDatabaseProxy(rawDb, {
        requireScope: true,
        label: 'knowledge-archive-test',
      });
    }, 60_000);
    afterAll(async () => {
      await (rawDb as Database & { $client: { end: () => Promise<void> } }).$client.end();
    });

    it('isolates discovery, counts, direct reads and archive/restore mutations, even for tenant admins', async () => {
      const tenantA = `archive-a-${generateId()}`;
      const tenantB = `archive-b-${generateId()}`;
      const documents = new KnowledgeDocumentsService(db);
      const search = new KnowledgeSearchService(db);
      const seed = (tenant: string) =>
        runWithTenantDatabaseScope(db, tenant, async (scoped) => {
          const owner = (await new UsersRepository(scoped).create({
            email: `owner-${generateId()}@test.local`,
            name: 'Owner',
            role: ROLES.ADMIN,
          })) as User;
          const namespace = await new KnowledgeNamespaceRepository(scoped).create({
            slug: 'same-slug',
            display_name: 'Disposable namespace',
            owner_user_id: owner.user_id,
          });
          const doc = await documents.putDocument(
            { namespace_slug: namespace.slug, path: 'same.md', content_text: '# Needle' },
            { user: owner }
          );
          return { owner, namespace, doc };
        });
      const a = await seed(tenantA);
      const b = await seed(tenantB);
      await runWithTenantDatabaseScope(db, tenantA, () =>
        documents.patch(a.doc.document_id, { archived: true }, { user: a.owner })
      );
      await runWithTenantDatabaseScope(db, tenantB, async () => {
        expect(
          (await documents.find({ user: b.owner, query: { archive_filter: 'archived' } })).total
        ).toBe(0);
        const all = await documents.find({
          user: b.owner,
          query: { archive_filter: 'all', $limit: 1 },
        });
        expect(all.total).toBe(1);
        expect(all.data[0].document_id).toBe(b.doc.document_id);
        expect(
          await search.find({ user: b.owner, query: { archive_filter: 'archived', q: 'Needle' } })
        ).toEqual([]);
        await expect(documents.get(a.doc.document_id, { user: b.owner })).rejects.toBeInstanceOf(
          NotFound
        );
        for (const archived of [true, false]) {
          await expect(
            documents.patch(a.doc.document_id, { archived }, { user: b.owner })
          ).rejects.toBeInstanceOf(NotFound);
        }
      });
      await runWithTenantDatabaseScope(db, tenantA, async () => {
        expect((await documents.find({ user: a.owner })).total).toBe(0);
        expect(
          (await documents.find({ user: a.owner, query: { archive_filter: 'archived' } })).total
        ).toBe(1);
        await expect(
          documents.putDocument(
            { namespace_slug: a.namespace.slug, path: a.doc.path, content_text: 'replacement' },
            { user: a.owner }
          )
        ).rejects.toBeInstanceOf(Conflict);
        expect(await documents.get(a.doc.document_id, { user: a.owner })).toMatchObject({
          archived: true,
        });
      });
      const restored = await Promise.all(
        [1, 2].map(() =>
          runWithTenantDatabaseScope(db, tenantA, () =>
            documents.patch(
              a.doc.document_id,
              { archived: false, expected_archived: true },
              { user: a.owner }
            )
          )
        )
      );
      expect(restored[0]).toEqual(restored[1]);
      expect(restored[0]).toMatchObject({
        archived: false,
        archived_at: null,
        current_version_id: a.doc.current_version_id,
      });
      await runWithTenantDatabaseScope(db, tenantA, async () => {
        expect(
          await new KnowledgeVersionsService(db).find({
            user: a.owner,
            query: { document_id: a.doc.document_id },
          })
        ).toHaveLength(1);
        expect(
          (await search.find({ user: a.owner, query: { q: 'Needle' } }))[0].document.document_id
        ).toBe(a.doc.document_id);
      });
      // Different connections race after their initial read: the locked recheck
      // must reject either the stale archive or the edit of a now-archived row.
      const race = await Promise.allSettled([
        runWithTenantDatabaseScope(db, tenantA, () =>
          documents.putDocument(
            {
              document_id: a.doc.document_id,
              content_text: '# Concurrent edit',
              expected_version: 1,
            },
            { user: a.owner }
          )
        ),
        runWithTenantDatabaseScope(db, tenantA, () =>
          documents.patch(
            a.doc.document_id,
            { archived: true, expected_version: 1 },
            { user: a.owner }
          )
        ),
      ]);
      expect(race.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      const rejected = race.find((result) => result.status === 'rejected');
      expect(rejected?.status === 'rejected' && rejected.reason).toBeInstanceOf(Conflict);
    });
  }
);
