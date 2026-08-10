/**
 * PostgreSQL integration proof for durable Knowledge embedding claims.
 *
 * Run with:
 *   AGOR_DB_DIALECT=postgresql \
 *   AGOR_TEST_POSTGRES_URL=postgresql://user:pw@host:5432/db \
 *   pnpm --filter @agor/core exec vitest run src/db/knowledge-embedding-ha.postgres.test.ts
 */

import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateId } from '../lib/ids';
import type {
  KnowledgeDocumentID,
  KnowledgeDocumentUnitID,
  KnowledgeNamespaceID,
  UserID,
} from '../types';
import { createDatabase, type Database } from './client';
import { executeRaw, isPostgresDatabase, select, update } from './database-wrapper';
import { initializeDatabase } from './migrate';
import {
  KnowledgeDocumentRepository,
  KnowledgeNamespaceRepository,
} from './repositories/knowledge';
import {
  buildKnowledgeEmbeddingRoutingScanSql,
  type KnowledgeEmbeddingRoutingCursor,
  KnowledgeEmbeddingWorkRepository,
} from './repositories/knowledge-embedding-work';
import { UsersRepository } from './repositories/users';
import { kbDocumentUnits } from './schema';
import { runWithSystemDatabaseScope, runWithTenantDatabaseScope } from './tenant-scope';

const postgresUrl = process.env.AGOR_TEST_POSTGRES_URL;
const usesPostgresSchema = process.env.AGOR_DB_DIALECT === 'postgresql';
const identity = (label: string) => ({ instanceId: label, bootId: `${label}-boot` });

interface SeededUnit {
  tenantId: string;
  namespaceId: KnowledgeNamespaceID;
  documentId: KnowledgeDocumentID;
  unitId: KnowledgeDocumentUnitID;
}

function firstRow(result: unknown): Record<string, unknown> {
  if (Array.isArray(result)) return (result[0] ?? {}) as Record<string, unknown>;
  const rows = (result as { rows?: unknown[] } | undefined)?.rows;
  return ((Array.isArray(rows) ? rows[0] : undefined) ?? {}) as Record<string, unknown>;
}

interface ExplainNode {
  'Node Type': string;
  'Index Name'?: string;
  'Actual Rows'?: number;
  'Shared Hit Blocks'?: number;
  'Shared Read Blocks'?: number;
  Plans?: ExplainNode[];
}

function explainNodes(result: unknown): ExplainNode[] {
  const value = firstRow(result)['QUERY PLAN'];
  const document = typeof value === 'string' ? JSON.parse(value) : value;
  const root = (Array.isArray(document) ? document[0] : document) as
    | { Plan?: ExplainNode }
    | undefined;
  if (!root?.Plan) throw new Error('PostgreSQL EXPLAIN JSON did not contain a root plan');
  const nodes: ExplainNode[] = [];
  const visit = (node: ExplainNode) => {
    nodes.push(node);
    for (const child of node.Plans ?? []) visit(child);
  };
  visit(root.Plan);
  return nodes;
}

async function seedPendingUnits(
  db: Database,
  tenantId: string,
  count: number
): Promise<SeededUnit[]> {
  return runWithTenantDatabaseScope(db, tenantId, async (scoped) => {
    const user = await new UsersRepository(scoped).create({
      user_id: generateId() as UserID,
      email: `${tenantId}-${generateId()}@example.com`,
      name: tenantId,
    });
    const namespace = await new KnowledgeNamespaceRepository(scoped).create({
      slug: `embedding-ha-${generateId()}`,
      display_name: `Embedding HA ${tenantId}`,
      created_by: user.user_id as UserID,
    });
    const documents = new KnowledgeDocumentRepository(scoped);
    const seeded: SeededUnit[] = [];
    for (let index = 0; index < count; index++) {
      const document = await documents.create({
        namespace_id: namespace.namespace_id,
        path: `doc-${index}.md`,
        title: `Doc ${index}`,
        content_text: `# Doc ${index}\n\nTenant ${tenantId}`,
        created_by: user.user_id as UserID,
      });
      const unit = await select(scoped)
        .from(kbDocumentUnits)
        .where(eq(kbDocumentUnits.version_id, document.current_version_id!))
        .one();
      await update(scoped, kbDocumentUnits)
        .set({ embedding_status: 'pending', updated_at: new Date() })
        .where(eq(kbDocumentUnits.unit_id, unit!.unit_id))
        .run();
      seeded.push({
        tenantId,
        namespaceId: namespace.namespace_id,
        documentId: document.document_id,
        unitId: unit!.unit_id as KnowledgeDocumentUnitID,
      });
    }
    return seeded;
  });
}

async function claim(
  db: Database,
  seeded: SeededUnit,
  token: string,
  instance: string,
  leaseMs = 60_000
) {
  return runWithTenantDatabaseScope(db, seeded.tenantId, (scoped) =>
    new KnowledgeEmbeddingWorkRepository(scoped).claimCurrentUnits({
      unitIds: [seeded.unitId],
      claimToken: token,
      leaseMs,
      identity: identity(instance),
      limit: 1,
    })
  );
}

describe.skipIf(!postgresUrl || !usesPostgresSchema)(
  'Knowledge embedding HA claims (PostgreSQL)',
  () => {
    let db: Database;

    beforeAll(async () => {
      db = createDatabase({ dialect: 'postgresql', url: postgresUrl! });
      await initializeDatabase(db);
      if (!isPostgresDatabase(db)) throw new Error('PostgreSQL test requires PostgreSQL');
    });

    afterAll(async () => {
      await (db as Database & { $client: { end: () => Promise<void> } }).$client.end();
    });

    it('elects one provider caller when multiple daemons race one document', async () => {
      const [seeded] = await seedPendingUnits(db, `embedding-race-${generateId()}`, 1);
      let providerCalls = 0;
      const claims = await Promise.all(
        Array.from({ length: 5 }, (_, index) =>
          claim(db, seeded, `race-token-${index}`, `daemon-${index}`).then((rows) => {
            if (rows.length > 0) providerCalls += 1;
            return rows;
          })
        )
      );

      expect(claims.filter((rows) => rows.length === 1)).toHaveLength(1);
      expect(providerCalls).toBe(1);
    });

    it('recovers an expired claim and fences the stale generation', async () => {
      const [seeded] = await seedPendingUnits(db, `embedding-expiry-${generateId()}`, 1);
      const [first] = await claim(db, seeded, 'expired-first', 'daemon-a');
      await runWithTenantDatabaseScope(db, seeded.tenantId, (scoped) =>
        executeRaw(
          scoped,
          sql`UPDATE kb_document_units
              SET embedding_claim_expires_at = CURRENT_TIMESTAMP - interval '1 second'
              WHERE unit_id = ${seeded.unitId}`
        ).then(() => undefined)
      );
      const [replacement] = await claim(db, seeded, 'expired-second', 'daemon-b');

      expect(replacement.claim_generation).toBeGreaterThan(first.claim_generation);
      const staleAdmission = await runWithTenantDatabaseScope(db, seeded.tenantId, (scoped) =>
        new KnowledgeEmbeddingWorkRepository(scoped).renewClaimsForProviderCall({
          claimToken: first.claim_token,
          claims: [first],
          leaseMs: 60_000,
        })
      );
      expect(staleAdmission).toEqual([]);
      const staleCommit = await runWithTenantDatabaseScope(db, seeded.tenantId, (scoped) =>
        new KnowledgeEmbeddingWorkRepository(scoped).completeClaims({
          claimToken: first.claim_token,
          embeddingSpaceId: 'stale-space-never-inserted',
          model: 'text-embedding-3-small',
          dimensions: 1536,
          completions: [
            {
              unitId: first.unit_id,
              claimGeneration: first.claim_generation,
              contentText: first.content_text,
              contentMd5: first.content_md5,
              contentSha256: 'stale-sha-never-inserted',
              embedding: '[0]',
            },
          ],
        })
      );
      expect(staleCommit).toEqual([]);

      const staleMutation = await runWithTenantDatabaseScope(db, seeded.tenantId, (scoped) =>
        new KnowledgeEmbeddingWorkRepository(scoped).failClaims({
          claimToken: first.claim_token,
          claims: [first],
          error: 'stale worker must lose',
          baseRetryMs: 1_000,
          maxRetryMs: 60_000,
        })
      );
      expect(staleMutation).toEqual([]);

      const currentMutation = await runWithTenantDatabaseScope(db, seeded.tenantId, (scoped) =>
        new KnowledgeEmbeddingWorkRepository(scoped).failClaims({
          claimToken: replacement.claim_token,
          claims: [replacement],
          error: 'current provider failure',
          baseRetryMs: 1_000,
          maxRetryMs: 60_000,
        })
      );
      expect(currentMutation).toEqual([seeded.unitId]);
    });

    it('renews exact claims at final admission and releases proven no-call ownership', async () => {
      const [seeded] = await seedPendingUnits(db, `embedding-admission-${generateId()}`, 1);
      const [first] = await claim(db, seeded, 'admission-first', 'daemon-a', 5_000);
      const admitted = await runWithTenantDatabaseScope(db, seeded.tenantId, (scoped) =>
        new KnowledgeEmbeddingWorkRepository(scoped).renewClaimsForProviderCall({
          claimToken: first.claim_token,
          claims: [first],
          leaseMs: 60_000,
        })
      );
      expect(admitted).toEqual([seeded.unitId]);

      const released = await runWithTenantDatabaseScope(db, seeded.tenantId, (scoped) =>
        new KnowledgeEmbeddingWorkRepository(scoped).releaseClaims({
          claimToken: first.claim_token,
          claims: [first],
        })
      );
      expect(released).toEqual([seeded.unitId]);
      await expect(claim(db, seeded, 'admission-second', 'daemon-b')).resolves.toHaveLength(1);
    });

    it('fences claims across document update and deletion races', async () => {
      const [updatedSeed, deletedSeed, namespaceDeletedSeed] = await seedPendingUnits(
        db,
        `embedding-doc-races-${generateId()}`,
        3
      );
      const [updateClaim] = await claim(db, updatedSeed, 'update-old', 'daemon-a');
      const [deleteClaim] = await claim(db, deletedSeed, 'delete-old', 'daemon-a');
      const [namespaceDeleteClaim] = await claim(
        db,
        namespaceDeletedSeed,
        'namespace-delete-old',
        'daemon-a'
      );

      await runWithTenantDatabaseScope(db, updatedSeed.tenantId, async (scoped) => {
        const documents = new KnowledgeDocumentRepository(scoped);
        await documents.update(updatedSeed.documentId, { content_text: '# New generation' });
        await documents.delete(deletedSeed.documentId);
        await new KnowledgeNamespaceRepository(scoped).delete(namespaceDeletedSeed.namespaceId);
      });

      const mutations = await runWithTenantDatabaseScope(
        db,
        updatedSeed.tenantId,
        async (scoped) => {
          const work = new KnowledgeEmbeddingWorkRepository(scoped);
          return [
            await work.failClaims({
              claimToken: updateClaim.claim_token,
              claims: [updateClaim],
              error: 'obsolete update',
              baseRetryMs: 1_000,
              maxRetryMs: 60_000,
            }),
            await work.failClaims({
              claimToken: deleteClaim.claim_token,
              claims: [deleteClaim],
              error: 'obsolete delete',
              baseRetryMs: 1_000,
              maxRetryMs: 60_000,
            }),
            await work.failClaims({
              claimToken: namespaceDeleteClaim.claim_token,
              claims: [namespaceDeleteClaim],
              error: 'obsolete namespace delete',
              baseRetryMs: 1_000,
              maxRetryMs: 60_000,
            }),
          ];
        }
      );
      expect(mutations).toEqual([[], [], []]);
    });

    it('paces provider failures durably and bounds each retry to one winner', async () => {
      const [seeded] = await seedPendingUnits(db, `embedding-retry-${generateId()}`, 1);
      const [first] = await claim(db, seeded, 'retry-first', 'daemon-a');
      await runWithTenantDatabaseScope(db, seeded.tenantId, (scoped) =>
        new KnowledgeEmbeddingWorkRepository(scoped).failClaims({
          claimToken: first.claim_token,
          claims: [first],
          error: 'provider unavailable',
          baseRetryMs: 60_000,
          maxRetryMs: 60_000,
        })
      );

      expect(await claim(db, seeded, 'retry-too-early', 'daemon-b')).toEqual([]);
      await runWithTenantDatabaseScope(db, seeded.tenantId, (scoped) =>
        executeRaw(
          scoped,
          sql`UPDATE kb_document_units
              SET embedding_retry_at = CURRENT_TIMESTAMP - interval '1 second'
              WHERE unit_id = ${seeded.unitId}`
        ).then(() => undefined)
      );
      const retries = await Promise.all(
        Array.from({ length: 4 }, (_, index) =>
          claim(db, seeded, `retry-${index}`, `daemon-retry-${index}`)
        )
      );
      expect(retries.filter((rows) => rows.length === 1)).toHaveLength(1);
    });

    it('honors Retry-After and operator-gates permanent provider failures', async () => {
      const [retrySeed, absoluteSeed, terminalSeed] = await seedPendingUnits(
        db,
        `embedding-provider-classification-${generateId()}`,
        3
      );
      const [retryClaim] = await claim(db, retrySeed, 'retry-after', 'daemon-a');
      const [absoluteClaim] = await claim(db, absoluteSeed, 'retry-after-date', 'daemon-a');
      const [terminalClaim] = await claim(db, terminalSeed, 'terminal-401', 'daemon-a');
      const absoluteRetryAt = new Date('2098-01-01T00:00:00.000Z');

      await runWithTenantDatabaseScope(db, retrySeed.tenantId, async (scoped) => {
        const work = new KnowledgeEmbeddingWorkRepository(scoped);
        await work.failClaims({
          claimToken: retryClaim.claim_token,
          claims: [retryClaim],
          error: 'rate limited',
          baseRetryMs: 1_000,
          maxRetryMs: 5_000,
          retryable: true,
          retryAfterMs: 60_000,
        });
        await work.failClaims({
          claimToken: absoluteClaim.claim_token,
          claims: [absoluteClaim],
          error: 'provider maintenance',
          baseRetryMs: 1_000,
          maxRetryMs: 5_000,
          retryable: true,
          retryAfterAt: absoluteRetryAt,
        });
        await work.failClaims({
          claimToken: terminalClaim.claim_token,
          claims: [terminalClaim],
          error: 'unauthorized',
          baseRetryMs: 1_000,
          maxRetryMs: 5_000,
          retryable: false,
        });
      });

      const classified = await runWithTenantDatabaseScope(db, retrySeed.tenantId, (scoped) =>
        executeRaw(
          scoped,
          sql`SELECT unit_id, embedding_status, embedding_retry_at,
                     EXTRACT(EPOCH FROM (embedding_retry_at - clock_timestamp())) * 1000 AS retry_in_ms
              FROM kb_document_units
              WHERE unit_id IN (${retrySeed.unitId}, ${absoluteSeed.unitId}, ${terminalSeed.unitId})
              ORDER BY unit_id`
        )
      );
      const rows = Array.isArray(classified) ? (classified as Array<Record<string, unknown>>) : [];
      const retryRow = rows.find((row) => row.unit_id === retrySeed.unitId)!;
      const absoluteRow = rows.find((row) => row.unit_id === absoluteSeed.unitId)!;
      const terminalRow = rows.find((row) => row.unit_id === terminalSeed.unitId)!;
      expect(retryRow.embedding_status).toBe('error');
      expect(Number(retryRow.retry_in_ms)).toBeGreaterThan(55_000);
      expect(new Date(String(absoluteRow.embedding_retry_at))).toEqual(absoluteRetryAt);
      expect(terminalRow).toMatchObject({
        embedding_status: 'not_configured',
        embedding_retry_at: null,
      });
      await expect(claim(db, terminalSeed, 'terminal-no-retry', 'daemon-b')).resolves.toEqual([]);
    });

    it('discovers fair routing refs but cannot claim or infer across tenants', async () => {
      const tenantA = `embedding-fair-a-${generateId()}`;
      const tenantB = `embedding-fair-b-${generateId()}`;
      const tenantC = `embedding-fair-c-${generateId()}`;
      const unitsA = await seedPendingUnits(db, tenantA, 5);
      const [unitB] = await seedPendingUnits(db, tenantB, 1);
      const [unitC] = await seedPendingUnits(db, tenantC, 1);

      const refs = await runWithSystemDatabaseScope(
        db,
        'Knowledge embedding HA integration discovery',
        (systemDb) =>
          new KnowledgeEmbeddingWorkRepository(systemDb).findRoutingRefs({
            limit: 100,
            perTenantLimit: 2,
          }),
        { capability: 'knowledge_embedding_discovery' }
      );
      const discoveredTenants = new Set(refs.map((ref) => ref.tenant_id));
      expect([...discoveredTenants]).toEqual(expect.arrayContaining([tenantA, tenantB, tenantC]));
      expect(Object.keys(refs[0] ?? {}).sort()).toEqual(
        ['eligible_at', 'tenant_id', 'unit_id'].sort()
      );

      // A daemon retains this keyset only for one bounded traversal. Even if
      // every page before these tenants is paused/unclaimable, subsequent
      // pages must eventually expose every eligible tenant before wrapping.
      const pagedTenants = new Set<string>();
      const through = await runWithSystemDatabaseScope(
        db,
        'Knowledge embedding HA traversal high-water',
        (systemDb) => new KnowledgeEmbeddingWorkRepository(systemDb).findRoutingHighWater(),
        { capability: 'knowledge_embedding_discovery' }
      );
      expect(through).not.toBeNull();
      let after: KnowledgeEmbeddingRoutingCursor | undefined;
      for (let pageNumber = 0; pageNumber < 256; pageNumber += 1) {
        const page = await runWithSystemDatabaseScope(
          db,
          'Knowledge embedding HA paginated discovery',
          (systemDb) =>
            new KnowledgeEmbeddingWorkRepository(systemDb).findRoutingPage({
              limit: 1,
              perTenantLimit: 2,
              through: through!,
              ...(after ? { after } : {}),
            }),
          { capability: 'knowledge_embedding_discovery' }
        );
        for (const ref of page.refs) {
          if (ref.tenant_id) pagedTenants.add(String(ref.tenant_id));
        }
        after = page.nextCursor ?? undefined;
        if (!after) break;
      }
      expect([...pagedTenants]).toEqual(expect.arrayContaining([tenantA, tenantB, tenantC]));
      expect(after).toBeUndefined();

      const crossTenantClaim = await runWithTenantDatabaseScope(db, tenantA, (scoped) =>
        new KnowledgeEmbeddingWorkRepository(scoped).claimCurrentUnits({
          unitIds: [unitB.unitId],
          claimToken: 'cross-tenant',
          leaseMs: 60_000,
          identity: identity('tenant-a-daemon'),
          limit: 1,
        })
      );
      const nonexistentClaim = await runWithTenantDatabaseScope(db, tenantA, (scoped) =>
        new KnowledgeEmbeddingWorkRepository(scoped).claimCurrentUnits({
          unitIds: [generateId() as KnowledgeDocumentUnitID],
          claimToken: 'nonexistent-unit',
          leaseMs: 60_000,
          identity: identity('tenant-a-daemon'),
          limit: 1,
        })
      );
      expect(crossTenantClaim).toEqual([]);
      expect(crossTenantClaim).toEqual(nonexistentClaim);
      expect(unitsA).toHaveLength(5);
      expect(unitC.tenantId).toBe(tenantC);
    });

    it('finishes a high-water traversal under sustained ingest and rediscovers expired work', async () => {
      const tenantId = `embedding-high-water-${generateId()}`;
      const [expiring, poisonParent] = await seedPendingUnits(db, tenantId, 2);
      const lowerBound: KnowledgeEmbeddingRoutingCursor = {
        createdAt: '2043-12-31T00:00:00.000Z',
        tenantId: 'cursor',
        unitId: 'cursor' as KnowledgeDocumentUnitID,
      };
      await runWithTenantDatabaseScope(db, tenantId, async (scoped) => {
        await executeRaw(
          scoped,
          sql`UPDATE kb_document_units
              SET created_at = CASE
                    WHEN unit_id = ${expiring.unitId} THEN timestamptz '2044-01-01 00:00:00+00'
                    ELSE timestamptz '2044-01-02 00:00:00+00'
                  END
              WHERE unit_id IN (${expiring.unitId}, ${poisonParent.unitId})`
        );
        await executeRaw(
          scoped,
          sql`UPDATE kb_document_units
              SET embedding_status = 'not_configured'
              WHERE unit_id = ${poisonParent.unitId}`
        );
        await executeRaw(
          scoped,
          sql`INSERT INTO kb_document_units (
                tenant_id, unit_id, document_id, version_id, ordinal,
                content_text, embedding_status, embedding_retry_at, created_at, updated_at
              )
              SELECT
                ${tenantId},
                ('highwater' || lpad(g::text, 27, '0'))::varchar(36),
                ${poisonParent.documentId},
                d.current_version_id,
                g,
                'future retry',
                'error',
                timestamptz '2099-01-01 00:00:00+00',
                timestamptz '2044-01-02 00:00:00+00' + g * interval '1 microsecond',
                CURRENT_TIMESTAMP
              FROM generate_series(1, 40) AS g
              JOIN kb_documents AS d ON d.document_id = ${poisonParent.documentId}`
        );
      });
      await claim(db, expiring, 'high-water-live-claim', 'daemon-a', 60_000);

      const through = await runWithSystemDatabaseScope(
        db,
        'Knowledge embedding sustained-ingest high-water',
        (systemDb) => new KnowledgeEmbeddingWorkRepository(systemDb).findRoutingHighWater(),
        { capability: 'knowledge_embedding_discovery' }
      );
      expect(through).not.toBeNull();

      let after: KnowledgeEmbeddingRoutingCursor | undefined = lowerBound;
      let pages = 0;
      do {
        const page = await runWithSystemDatabaseScope(
          db,
          'Knowledge embedding sustained-ingest traversal',
          (systemDb) =>
            new KnowledgeEmbeddingWorkRepository(systemDb).findRoutingPage({
              limit: 2,
              perTenantLimit: 2,
              after,
              through: through!,
            }),
          { capability: 'knowledge_embedding_discovery' }
        );
        pages += 1;
        if (pages === 1) {
          await runWithTenantDatabaseScope(db, tenantId, (scoped) =>
            executeRaw(
              scoped,
              sql`UPDATE kb_document_units
                  SET embedding_claim_expires_at = clock_timestamp() - interval '1 second'
                  WHERE unit_id = ${expiring.unitId}`
            ).then(() => undefined)
          );
        }
        await runWithTenantDatabaseScope(db, tenantId, (scoped) =>
          executeRaw(
            scoped,
            sql`INSERT INTO kb_document_units (
                  tenant_id, unit_id, document_id, version_id, ordinal,
                  content_text, embedding_status, created_at, updated_at
                )
                SELECT ${tenantId}, ${generateId()}, ${poisonParent.documentId},
                       d.current_version_id, ${10_000 + pages}, 'new ingest', 'pending',
                       timestamptz '2045-01-01 00:00:00+00' + ${pages} * interval '1 second',
                       CURRENT_TIMESTAMP
                FROM kb_documents AS d WHERE d.document_id = ${poisonParent.documentId}`
          ).then(() => undefined)
        );
        after = page.nextCursor ?? undefined;
      } while (after && pages < 20);

      expect(after).toBeUndefined();
      expect(pages).toBeLessThan(20);

      const nextThrough = await runWithSystemDatabaseScope(
        db,
        'Knowledge embedding next sustained-ingest high-water',
        (systemDb) => new KnowledgeEmbeddingWorkRepository(systemDb).findRoutingHighWater(),
        { capability: 'knowledge_embedding_discovery' }
      );
      const rediscovered = await runWithSystemDatabaseScope(
        db,
        'Knowledge embedding expired-work rediscovery',
        (systemDb) =>
          new KnowledgeEmbeddingWorkRepository(systemDb).findRoutingPage({
            limit: 2,
            perTenantLimit: 2,
            after: lowerBound,
            through: nextThrough!,
          }),
        { capability: 'knowledge_embedding_discovery' }
      );
      expect(rediscovered.refs.map((ref) => ref.unit_id)).toContain(expiring.unitId);
    });

    it('bounds every routing query and advances across poison rows with an index-backed plan', async () => {
      const poisonTenant = `embedding-poison-${generateId()}`;
      const runnableTenant = `embedding-runnable-${generateId()}`;
      const [poisonParent] = await seedPendingUnits(db, poisonTenant, 1);
      const [runnable] = await seedPendingUnits(db, runnableTenant, 1);
      const poisonPrefix = generateId().slice(0, 8);

      await runWithTenantDatabaseScope(db, poisonTenant, async (scoped) => {
        await executeRaw(
          scoped,
          sql`UPDATE kb_document_units
              SET embedding_status = 'not_configured'
              WHERE unit_id = ${poisonParent.unitId}`
        );
        await executeRaw(
          scoped,
          sql`INSERT INTO kb_document_units (
                tenant_id, unit_id, document_id, version_id, ordinal,
                content_text, embedding_status, embedding_retry_at, created_at, updated_at
              )
              SELECT
                ${poisonTenant},
                (${poisonPrefix} || lpad(g::text, 28, '0'))::varchar(36),
                ${poisonParent.documentId},
                d.current_version_id,
                g,
                'poison',
                'error',
                timestamptz '2099-01-01 00:00:00+00',
                timestamptz '2036-01-01 00:00:00+00' + g * interval '1 microsecond',
                CURRENT_TIMESTAMP
              FROM generate_series(1, 2000) AS g
              JOIN kb_documents AS d ON d.document_id = ${poisonParent.documentId}`
        );
      });
      await runWithTenantDatabaseScope(db, runnableTenant, (scoped) =>
        executeRaw(
          scoped,
          sql`UPDATE kb_document_units
              SET created_at = timestamptz '2036-01-02 00:00:00+00'
              WHERE unit_id = ${runnable.unitId}`
        ).then(() => undefined)
      );

      let after: KnowledgeEmbeddingRoutingCursor | undefined = {
        createdAt: '2035-12-31T00:00:00.000Z',
        tenantId: 'cursor',
        unitId: 'cursor' as KnowledgeDocumentUnitID,
      };
      let pages = 0;
      let foundRunnable = false;
      const traversalThrough: KnowledgeEmbeddingRoutingCursor = {
        createdAt: '2036-01-02T00:00:00.000Z',
        tenantId: runnableTenant,
        unitId: runnable.unitId,
      };
      while (after && pages < 600) {
        const page = await runWithSystemDatabaseScope(
          db,
          'Knowledge embedding poison traversal',
          (systemDb) =>
            new KnowledgeEmbeddingWorkRepository(systemDb).findRoutingPage({
              limit: 1,
              perTenantLimit: 1,
              after,
              through: traversalThrough!,
            }),
          { capability: 'knowledge_embedding_discovery' }
        );
        pages += 1;
        foundRunnable ||= page.refs.some((ref) => ref.unit_id === runnable.unitId);
        after = page.nextCursor ?? undefined;
      }
      expect(foundRunnable).toBe(true);
      expect(pages).toBeLessThanOrEqual(501);

      const planPrefix = generateId().replaceAll('-', '').slice(-8);
      await runWithTenantDatabaseScope(db, poisonTenant, (scoped) =>
        executeRaw(
          scoped,
          sql`INSERT INTO kb_document_units (
                tenant_id, unit_id, document_id, version_id, ordinal,
                content_text, embedding_status, embedding_retry_at, created_at, updated_at
              )
              SELECT
                ${poisonTenant},
                (${planPrefix} || lpad(g::text, 28, '0'))::varchar(36),
                ${poisonParent.documentId},
                d.current_version_id,
                10000 + g,
                'representative plan backlog',
                'error',
                timestamptz '2099-01-01 00:00:00+00',
                timestamptz '2038-01-01 00:00:00+00' + g * interval '1 microsecond',
                CURRENT_TIMESTAMP
              FROM generate_series(1, 100000) AS g
              JOIN kb_documents AS d ON d.document_id = ${poisonParent.documentId}`
        ).then(() => undefined)
      );
      await executeRaw(db, sql`ANALYZE kb_document_units`);

      const through = await runWithSystemDatabaseScope(
        db,
        'Knowledge embedding production routing EXPLAIN high-water',
        (systemDb) => new KnowledgeEmbeddingWorkRepository(systemDb).findRoutingHighWater(),
        { capability: 'knowledge_embedding_discovery' }
      );

      const explained = await runWithSystemDatabaseScope(
        db,
        'Knowledge embedding production routing EXPLAIN',
        (systemDb) =>
          executeRaw(
            systemDb,
            sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
                ${buildKnowledgeEmbeddingRoutingScanSql({ limit: 32, through: through! })}`
          ),
        { capability: 'knowledge_embedding_discovery' }
      );
      const nodes = explainNodes(explained);
      const scan = nodes.find(
        (node) => node['Index Name'] === 'kb_document_units_embedding_work_scan_idx'
      );
      expect(scan?.['Node Type']).toMatch(/^Index(?: Only)? Scan$/);
      expect(scan?.['Actual Rows']).toBeLessThanOrEqual(129);
      expect(scan?.['Shared Hit Blocks']).toEqual(expect.any(Number));
      expect(scan?.['Shared Read Blocks']).toEqual(expect.any(Number));
      expect(nodes.map((node) => node['Node Type'])).not.toContain('WindowAgg');
      console.info(
        `[knowledge-embedding-plan] node=${scan?.['Node Type']} index=${scan?.['Index Name']} actual_rows=${scan?.['Actual Rows']} shared_hit_blocks=${scan?.['Shared Hit Blocks']} shared_read_blocks=${scan?.['Shared Read Blocks']}`
      );
    });
  }
);
