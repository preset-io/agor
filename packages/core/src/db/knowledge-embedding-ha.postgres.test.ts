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
      let after: KnowledgeEmbeddingRoutingCursor | undefined;
      for (let pageNumber = 0; pageNumber < 256; pageNumber += 1) {
        const page = await runWithSystemDatabaseScope(
          db,
          'Knowledge embedding HA paginated discovery',
          (systemDb) =>
            new KnowledgeEmbeddingWorkRepository(systemDb).findRoutingPage({
              limit: 1,
              perTenantLimit: 2,
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
  }
);
