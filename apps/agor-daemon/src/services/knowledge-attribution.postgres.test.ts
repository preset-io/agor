/**
 * Production-shaped Knowledge author attribution coverage. The shared
 * PostgreSQL runner supplies a disposable non-superuser, NOBYPASSRLS role.
 */

import {
  createDatabase,
  createTenantScopedDatabaseProxy,
  type Database,
  executeRaw,
  generateId,
  initializeDatabase,
  isPostgresDatabase,
  KnowledgeDocumentRepository,
  KnowledgeNamespaceRepository,
  runWithTenantDatabaseScope,
  sql,
  type TenantScopeAwareDatabase,
  UsersRepository,
} from '@agor/core/db';
import { NotFound } from '@agor/core/feathers';
import type { User, UserID } from '@agor/core/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { KnowledgeDocumentsService } from './knowledge-documents.js';
import { KnowledgeVersionsService } from './knowledge-versions.js';

const postgresUrl = process.env.AGOR_TEST_POSTGRES_URL;
const usesPostgresSchema = process.env.AGOR_DB_DIALECT === 'postgresql';

function rowsOf(result: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(result)) return result as Array<Record<string, unknown>>;
  const rows = (result as { rows?: unknown[] } | undefined)?.rows;
  return Array.isArray(rows) ? (rows as Array<Record<string, unknown>>) : [];
}

function params(user: User, query?: Record<string, unknown>) {
  return { user, query } as never;
}

describe.skipIf(!postgresUrl || !usesPostgresSchema)(
  'Knowledge author attribution service projection (PostgreSQL/RLS)',
  () => {
    let rawDb: Database;
    let db: TenantScopeAwareDatabase;

    beforeAll(async () => {
      rawDb = createDatabase({ dialect: 'postgresql', url: postgresUrl! });
      await initializeDatabase(rawDb);
      if (!isPostgresDatabase(rawDb)) throw new Error('PostgreSQL test requires PostgreSQL');
      const [role] = rowsOf(
        await executeRaw(
          rawDb,
          sql`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`
        )
      );
      expect(role).toMatchObject({ rolsuper: false, rolbypassrls: false });
      db = createTenantScopedDatabaseProxy(rawDb, {
        requireScope: true,
        label: 'knowledge-attribution-test',
      });
    }, 60_000);

    afterAll(async () => {
      await (rawDb as Database & { $client: { end: () => Promise<void> } }).$client.end();
    });

    it('projects human and teammate authors without profile data and isolates other tenants', async () => {
      const tenantA = `knowledge-author-a-${generateId()}`;
      const tenantB = `knowledge-author-b-${generateId()}`;
      const documents = new KnowledgeDocumentsService(db);
      const history = new KnowledgeVersionsService(db);

      const a = await runWithTenantDatabaseScope(db, tenantA, async (scoped) => {
        const users = new UsersRepository(scoped);
        const owner = (await users.create({
          email: `owner-${generateId()}@tenant-a.test`,
          name: 'Postgres Owner',
        })) as User;
        const teammate = (await users.create({
          email: `teammate-${generateId()}@tenant-a.test`,
          name: 'Postgres Teammate',
        })) as User;
        const namespace = await new KnowledgeNamespaceRepository(scoped).create({
          slug: `attribution-${generateId()}`,
          display_name: 'Attribution',
          owner_user_id: owner.user_id,
          others_can: 'write',
        });
        return { owner, teammate, namespace };
      });
      const b = await runWithTenantDatabaseScope(db, tenantB, async (scoped) => ({
        user: (await new UsersRepository(scoped).create({
          email: `private-${generateId()}@tenant-b.test`,
          name: 'Tenant B Private Name',
        })) as User,
      }));

      const created = await runWithTenantDatabaseScope(db, tenantA, () =>
        documents.putDocument(
          {
            namespace_slug: a.namespace.slug,
            path: 'authors.md',
            content_text: '# Authors\n\nHuman',
            edit_policy: 'public',
          },
          params(a.owner)
        )
      );
      const sessionId = generateId();
      await runWithTenantDatabaseScope(db, tenantA, () =>
        documents.putDocument(
          {
            document_id: created.document_id,
            content_text: '# Authors\n\nAssistant',
            expected_version: 1,
          },
          {
            user: a.teammate,
            knowledgeWriteAttribution: {
              sessionId,
              agenticTool: 'codex',
              teammateName: 'Scout',
            },
          }
        )
      );

      const response = await runWithTenantDatabaseScope(db, tenantA, async () => ({
        document: await documents.getDocument(
          { document_id: created.document_id, include_content: true },
          params(a.owner)
        ),
        versions: await history.find(
          params(a.owner, { document_id: created.document_id, include_content: true })
        ),
      }));
      expect(response.document).toMatchObject({
        updated_by: a.teammate.user_id,
        updated_by_user: { status: 'resolved', display_name: 'Postgres Teammate' },
        updated_by_session_id: sessionId,
        updated_by_agentic_tool: 'codex',
        updated_by_teammate_name: 'Scout',
        current_version: {
          created_by_user: { status: 'resolved', display_name: 'Postgres Teammate' },
          created_by_session_id: sessionId,
          created_by_agentic_tool: 'codex',
          created_by_teammate_name: 'Scout',
        },
      });
      expect(response.versions).toHaveLength(2);
      expect(response.versions[0]).toMatchObject({
        created_by_user: { status: 'resolved', display_name: 'Postgres Teammate' },
        created_by_teammate_name: 'Scout',
      });
      expect(response.versions[1]).toMatchObject({
        created_by_user: { status: 'resolved', display_name: 'Postgres Owner' },
        created_by_session_id: null,
      });

      const serialized = JSON.stringify(response);
      expect(serialized).not.toContain(a.owner.email);
      expect(serialized).not.toContain(a.teammate.email);
      expect(serialized).not.toContain(b.user.name!);
      expect(serialized).not.toContain(b.user.email);

      await runWithTenantDatabaseScope(db, tenantB, async () => {
        await expect(documents.get(created.document_id, params(b.user))).rejects.toBeInstanceOf(
          NotFound
        );
        await expect(
          history.find(params(b.user, { document_id: created.document_id }))
        ).resolves.toEqual([]);
      });
    });

    it('does not broaden an author lookup when a historical ID is invisible under RLS', async () => {
      const tenantA = `knowledge-unavailable-a-${generateId()}`;
      const tenantB = `knowledge-unavailable-b-${generateId()}`;
      const documents = new KnowledgeDocumentsService(db);
      const history = new KnowledgeVersionsService(db);

      const hidden = await runWithTenantDatabaseScope(db, tenantB, async (scoped) =>
        new UsersRepository(scoped).create({
          email: `hidden-${generateId()}@tenant-b.test`,
          name: 'Do Not Enumerate This Name',
        })
      );
      const seeded = await runWithTenantDatabaseScope(db, tenantA, async (scoped) => {
        const viewer = (await new UsersRepository(scoped).create({
          email: `viewer-${generateId()}@tenant-a.test`,
          name: 'Tenant A Viewer',
        })) as User;
        const namespace = await new KnowledgeNamespaceRepository(scoped).create({
          slug: `unavailable-${generateId()}`,
          display_name: 'Unavailable historical author',
          owner_user_id: viewer.user_id,
        });
        // The legacy schema has globally keyed author FKs. Deliberately create
        // a malformed historical reference to prove the projection still
        // resolves only inside the active tenant's RLS scope.
        const document = await new KnowledgeDocumentRepository(scoped).create({
          namespace_id: namespace.namespace_id,
          path: 'legacy.md',
          title: 'Legacy',
          visibility: 'public',
          content_text: 'legacy',
          created_by: hidden.user_id as UserID,
        });
        return { viewer, document };
      });

      const response = await runWithTenantDatabaseScope(db, tenantA, async () => ({
        document: await documents.getDocument(
          { document_id: seeded.document.document_id, include_content: true },
          params(seeded.viewer)
        ),
        versions: await history.find(
          params(seeded.viewer, {
            document_id: seeded.document.document_id,
            include_content: true,
          })
        ),
      }));
      expect(response.document).toMatchObject({
        updated_by: null,
        updated_by_user: { status: 'unavailable', display_name: 'Unavailable user' },
        current_version: {
          created_by: null,
          created_by_user: { status: 'unavailable', display_name: 'Unavailable user' },
        },
      });
      expect(response.versions[0]).toMatchObject({
        created_by: null,
        created_by_user: { status: 'unavailable', display_name: 'Unavailable user' },
      });
      const serialized = JSON.stringify(response);
      expect(serialized).not.toContain(hidden.user_id);
      expect(serialized).not.toContain(hidden.name!);
      expect(serialized).not.toContain(hidden.email);
    });
  }
);
