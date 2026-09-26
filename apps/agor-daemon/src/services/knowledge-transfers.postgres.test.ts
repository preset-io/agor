import {
  createDatabase,
  createTenantScopedDatabaseProxy,
  type Database,
  executeRaw,
  generateId,
  initializeDatabase,
  runWithTenantDatabaseScope,
  sql,
  type TenantScopeAwareDatabase,
  UsersRepository,
} from '@agor/core/db';
import { transferSha256 } from '@agor/core/knowledge';
import { type KnowledgeTransferEntry, ROLES, type User } from '@agor/core/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { KnowledgeTransfersService } from './knowledge-transfers';

const postgresUrl = process.env.AGOR_TEST_POSTGRES_URL;
describe.skipIf(!postgresUrl || process.env.AGOR_DB_DIALECT !== 'postgresql')(
  'Knowledge transfer RLS',
  () => {
    let raw: Database;
    let db: TenantScopeAwareDatabase;
    beforeAll(async () => {
      raw = createDatabase({ dialect: 'postgresql', url: postgresUrl! });
      await initializeDatabase(raw);
      const result = await executeRaw(
        raw,
        sql`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`
      );
      const rows = Array.isArray(result) ? result : (result as { rows: unknown[] }).rows;
      expect(rows[0]).toMatchObject({ rolsuper: false, rolbypassrls: false });
      db = createTenantScopedDatabaseProxy(raw, {
        requireScope: true,
        label: 'knowledge-transfer-test',
      });
    }, 60_000);
    afterAll(async () => {
      await (raw as Database & { $client: { end: () => Promise<void> } }).$client.end();
    });
    it('isolates inventory, source IDs, receipts and replay for identical bundle/slug/key', async () => {
      const a = `kb-transfer-a-${generateId()}`;
      const b = `kb-transfer-b-${generateId()}`;
      const seed = (tenant: string) =>
        runWithTenantDatabaseScope(
          db,
          tenant,
          async (tx) =>
            new UsersRepository(tx).create({
              email: `${generateId()}@test.invalid`,
              name: 'Synthetic admin',
              role: ROLES.ADMIN,
            }) as Promise<User>
        );
      const ua = await seed(a);
      const ub = await seed(b);
      const service = new KnowledgeTransfersService(db);
      const bundle = 'b'.repeat(64);
      const namespace = {
        action: 'namespace',
        bundle,
        slug: 'same-slug',
        display_name: 'Same',
        description: null,
        resume: false,
      };
      const entry: KnowledgeTransferEntry = {
        key: 'd000001',
        path: 'private.md',
        title: 'Private',
        icon_emoji: null,
        kind: 'doc',
        status: 'published',
        sha256: transferSha256('private synthetic A'),
        bytes: 19,
        frontmatter: null,
        provenance: {},
      };
      const doc = await runWithTenantDatabaseScope(db, a, async () => {
        await service.create(namespace, { user: ua });
        return service.create(
          {
            action: 'document',
            bundle,
            slug: namespace.slug,
            entry,
            content: 'private synthetic A',
          },
          { user: ua }
        );
      });
      await runWithTenantDatabaseScope(db, b, async () => {
        const absent = await service.find({
          user: ub,
          query: { namespace: namespace.slug, bundle },
        });
        expect(absent.namespace).toBeNull();
        expect(absent.receipts).toEqual([]);
        await expect(
          service.find({ user: ub, query: { namespace: namespace.slug } })
        ).rejects.toThrow();
        await expect(
          service.create(
            { action: 'reconcile', bundle, slug: namespace.slug, key: entry.key },
            { user: ub }
          )
        ).rejects.toThrow();
        await service.create(namespace, { user: ub });
        const inventory = await service.find({ user: ub, query: { namespace: namespace.slug } });
        expect(inventory.entries).toEqual([]);
      });
      const version = await runWithTenantDatabaseScope(
        db,
        a,
        async () =>
          (await service.find({ user: ua, query: { namespace: namespace.slug } })).entries[0]
            .version_id
      );
      await runWithTenantDatabaseScope(db, b, async () => {
        await expect(
          service.get(doc.target_id, { user: ub, query: { namespace: namespace.slug, version } })
        ).rejects.toThrow();
        const createdB = await service.create(
          {
            action: 'document',
            bundle,
            slug: namespace.slug,
            entry,
            content: 'private synthetic A',
          },
          { user: ub }
        );
        expect(createdB.target_id).not.toBe(doc.target_id);
      });
      const replay = await runWithTenantDatabaseScope(db, a, () =>
        service.create(
          {
            action: 'document',
            bundle,
            slug: namespace.slug,
            entry,
            content: 'private synthetic A',
          },
          { user: ua }
        )
      );
      expect(replay).toEqual({ target_id: doc.target_id, skipped: true });
    });
  }
);
