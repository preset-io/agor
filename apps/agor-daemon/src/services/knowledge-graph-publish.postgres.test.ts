/**
 * Production-shaped Knowledge graph publishing coverage. The shared
 * PostgreSQL runner supplies a disposable non-superuser, NOBYPASSRLS role.
 */

import {
  createDatabase,
  createTenantScopedDatabaseProxy,
  type Database,
  eq,
  executeRaw,
  generateId,
  initializeDatabase,
  isPostgresDatabase,
  KnowledgeGraphRepository,
  KnowledgeNamespaceRepository,
  kbGraphEdges,
  kbGraphNodes,
  runWithTenantDatabaseScope,
  select,
  sql,
  type TenantScopeAwareDatabase,
  UsersRepository,
  update,
} from '@agor/core/db';
import { NotFound } from '@agor/core/feathers';
import type { User } from '@agor/core/types';
import { buildKnowledgeDocumentUri } from '@agor/core/types';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { KnowledgeDocumentsService } from './knowledge-documents.js';

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
  'Knowledge graph publish regression (PostgreSQL/RLS)',
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
      // Exercise the migrated production index, not just the Drizzle schema
      // declaration (which historically described a partial index instead).
      const [index] = rowsOf(
        await executeRaw(
          rawDb,
          sql`SELECT indexdef FROM pg_indexes WHERE indexname = 'kb_graph_edges_tenant_source_target_type_unique'`
        )
      );
      expect(index.indexdef).not.toContain('WHERE');
      db = createTenantScopedDatabaseProxy(rawDb, {
        requireScope: true,
        label: 'knowledge-graph-publish-test',
      });
    }, 60_000);

    afterAll(async () => {
      await (rawDb as Database & { $client: { end: () => Promise<void> } }).$client.end();
    });

    it('restores removed links without losing edge identity or metadata', async () => {
      const tenant = `graph-${generateId()}`;
      const documents = new KnowledgeDocumentsService(db);
      const graph = new KnowledgeGraphRepository(db);
      const scope = <T>(work: () => Promise<T>) => runWithTenantDatabaseScope(db, tenant, work);
      const { owner, namespace } = await scope(async () => {
        const owner = (await new UsersRepository(db).create({
          email: `${generateId()}@test.invalid`,
          name: 'Fixture',
        })) as User;
        const namespace = await new KnowledgeNamespaceRepository(db).create({
          slug: `graph-${generateId()}`,
          display_name: 'Fixture',
          owner_user_id: owner.user_id,
        });
        return { owner, namespace };
      });
      const target = await scope(() =>
        documents.putDocument(
          { namespace_slug: namespace.slug, path: 'target.md', content_text: 'Target' },
          params(owner)
        )
      );
      const source = await scope(() =>
        documents.putDocument(
          { namespace_slug: namespace.slug, path: 'source.md', content_text: 'Source' },
          params(owner)
        )
      );
      const sourceRef = { uri: buildKnowledgeDocumentUri(source.document_id) };
      const targetRef = { uri: buildKnowledgeDocumentUri(target.document_id) };
      const manual = await scope(() =>
        graph.link({
          source: sourceRef,
          target: targetRef,
          edge_type: 'references',
          properties: { fixture: true },
          confidence: 0.75,
          created_by: owner.user_id,
        })
      );
      const links = `[id](${targetRef.uri}) [path](agor://kb/${namespace.slug}/target.md#section) [alias](/kb/${namespace.slug}/%74arget.md?view=1) [duplicate](${targetRef.uri})`;
      const publish = (content_text: string) =>
        scope(() =>
          documents.putDocument({ document_id: source.document_id, content_text }, params(owner))
        );
      await publish(links);
      await publish('Removed');
      expect(
        (await scope(() => graph.neighbors({ node: sourceRef, direction: 'out' }))).edges
      ).toEqual([]);
      await publish(links);
      await publish(links);
      const edges = (await scope(() => graph.neighbors({ node: sourceRef, direction: 'out' })))
        .edges;
      expect(edges).toHaveLength(1);
      expect(edges[0]).toMatchObject({
        edge_id: manual.edge_id,
        properties: { fixture: true },
        confidence: 0.75,
        archived: false,
      });
      const saved = await scope(() =>
        documents.getDocument(
          { document_id: source.document_id, include_content: true },
          params(owner)
        )
      );
      expect(saved.current_version?.version_number).toBe(5);
      const node = await scope(() => graph.findNode(sourceRef));
      await runWithTenantDatabaseScope(db, `foreign-${generateId()}`, async () => {
        await expect(graph.neighbors({ node: sourceRef })).rejects.toThrow();
        await expect(documents.get(source.document_id, params(owner))).rejects.toBeInstanceOf(
          NotFound
        );
        await expect(
          graph.syncOutgoingEdges({
            source: { node_id: node!.node_id },
            targets: [],
            edge_type: 'references',
          })
        ).rejects.toThrow();
        await update(db, kbGraphEdges)
          .set({ archived: true })
          .where(eq(kbGraphEdges.edge_id, manual.edge_id))
          .run();
        expect(
          await select(db).from(kbGraphEdges).where(eq(kbGraphEdges.edge_id, manual.edge_id)).all()
        ).toEqual([]);
      });
      expect((await scope(() => graph.neighbors({ node: sourceRef }))).edges[0].archived).toBe(
        false
      );

      // Same-tenant graph and document writers share the source lock. Competing
      // document versions must leave the graph matching the committed content.
      await Promise.all([publish(links), publish('Concurrent removal')]);
      const concurrent = await scope(() =>
        documents.getDocument(
          { document_id: source.document_id, include_content: true },
          params(owner)
        )
      );
      const concurrentEdges = (await scope(() => graph.neighbors({ node: sourceRef }))).edges;
      expect(concurrentEdges).toHaveLength(
        concurrent.current_version?.content_text === links ? 1 : 0
      );
      await Promise.all([
        publish(links),
        scope(() => graph.link({ source: sourceRef, target: targetRef, edge_type: 'references' })),
      ]);
      expect((await scope(() => graph.neighbors({ node: sourceRef }))).edges).toHaveLength(1);

      // An actual SQL error AFTER an archive must undo every graph mutation,
      // retain its primary SQLSTATE in safe diagnostics, and leave the outer
      // tenant transaction usable (including attribution and version commit).
      const replacement = await scope(() =>
        documents.putDocument(
          { namespace_slug: namespace.slug, path: 'replacement.md', content_text: 'Replacement' },
          params(owner)
        )
      );
      await executeRaw(
        rawDb,
        sql`CREATE FUNCTION kb_graph_fixture_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture-private-query-params' USING ERRCODE = '23514'; END $$`
      );
      await executeRaw(
        rawDb,
        sql`CREATE TRIGGER kb_graph_fixture_failure BEFORE INSERT ON kb_graph_edges FOR EACH ROW EXECUTE FUNCTION kb_graph_fixture_failure()`
      );
      const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        await publish(`[replacement](${buildKnowledgeDocumentUri(replacement.document_id)})`);
        expect(diagnostic).toHaveBeenCalledExactlyOnceWith(
          'Knowledge graph sync rolled back: sqlstate=23514'
        );
        const afterFailure = await scope(() =>
          documents.getDocument(
            { document_id: source.document_id, include_content: true },
            params(owner)
          )
        );
        expect(afterFailure.current_version?.version_number).toBe(9);
        expect(afterFailure.current_version?.content_text).toContain('replacement');
        expect((await scope(() => graph.neighbors({ node: sourceRef }))).edges[0].edge_id).toBe(
          manual.edge_id
        );
      } finally {
        diagnostic.mockRestore();
        await executeRaw(rawDb, sql`DROP TRIGGER kb_graph_fixture_failure ON kb_graph_edges`);
        await executeRaw(rawDb, sql`DROP FUNCTION kb_graph_fixture_failure()`);
      }
      await publish(`[replacement](${buildKnowledgeDocumentUri(replacement.document_id)})`);
      expect((await scope(() => graph.neighbors({ node: sourceRef }))).edges).toHaveLength(1);
      await scope(() => documents.remove(replacement.document_id, params(owner)));
      await publish(`[archived](${buildKnowledgeDocumentUri(replacement.document_id)})`);
      expect((await scope(() => graph.neighbors({ node: sourceRef }))).edges).toEqual([]);
      await expect(
        scope(async () => {
          await documents.putDocument(
            { document_id: source.document_id, content_text: links },
            params(owner)
          );
          throw new Error('fixture outer rollback');
        })
      ).rejects.toThrow('fixture outer rollback');
      expect((await scope(() => graph.neighbors({ node: sourceRef }))).edges).toEqual([]);
      const committed = await scope(() =>
        documents.getDocument(
          { document_id: source.document_id, include_content: true },
          params(owner)
        )
      );
      expect(committed.current_version?.version_number).toBe(11);
    });

    it('serializes concurrent node creation, link insertion and complete replacement', async () => {
      const graph = new KnowledgeGraphRepository(db);
      const scope = <T>(work: () => Promise<T>) =>
        runWithTenantDatabaseScope(db, `concurrent-fixture`, work);
      const source = { uri: `https://fixture.invalid/${generateId()}` };
      const target = { uri: `https://fixture.invalid/${generateId()}` };
      const edges = await Promise.all(
        Array.from({ length: 6 }, () =>
          scope(() =>
            graph.link({ source, target, edge_type: 'references', properties: { keep: true } })
          )
        )
      );
      expect(new Set(edges.map((edge) => edge.edge_id)).size).toBe(1);
      // Opposite directions must not deadlock on graph-node foreign keys.
      await Promise.all([
        scope(() => graph.link({ source, target, edge_type: 'related_to' })),
        scope(() => graph.link({ source: target, target: source, edge_type: 'related_to' })),
      ]);
      const other = { uri: `https://fixture.invalid/${generateId()}` };
      await Promise.all([
        scope(() =>
          graph.syncOutgoingEdges({ source, edge_type: 'references', targets: [target, target] })
        ),
        scope(() => graph.syncOutgoingEdges({ source, edge_type: 'references', targets: [other] })),
      ]);
      expect(
        (
          await scope(() =>
            graph.neighbors({ node: source, direction: 'out', edge_types: ['references'] })
          )
        ).edges
      ).toHaveLength(1);
      await scope(() =>
        graph.syncOutgoingEdges({ source, edge_type: 'references', targets: [target] })
      );
      expect(
        (
          await scope(() =>
            graph.neighbors({ node: source, direction: 'out', edge_types: ['references'] })
          )
        ).edges[0]
      ).toMatchObject({ edge_id: edges[0].edge_id, properties: { keep: true } });
      const sourceNode = await scope(() => graph.findNode(source));
      for (const ref of [{ node_id: sourceNode!.node_id }, source]) {
        await scope(async () => {
          await update(db, kbGraphNodes)
            .set({ archived: true, metadata: { retained: true } })
            .where(eq(kbGraphNodes.node_id, sourceNode!.node_id))
            .run();
          await graph.link({ source: ref, target, edge_type: 'references' });
          expect((await graph.neighbors({ node: ref })).center).toMatchObject({
            node_id: sourceNode!.node_id,
            archived: false,
            metadata: { retained: true },
          });
        });
      }
      await runWithTenantDatabaseScope(db, 'other-concurrent-fixture', async () => {
        const isolated = await graph.link({ source, target, edge_type: 'references' });
        expect(isolated.edge_id).not.toBe(edges[0].edge_id);
        expect(isolated.source_node_id).not.toBe(sourceNode!.node_id);
      });
    });
  }
);
