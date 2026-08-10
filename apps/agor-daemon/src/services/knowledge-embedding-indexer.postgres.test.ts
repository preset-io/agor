/**
 * End-to-end daemon/provider proof for the Knowledge embedding claim protocol.
 * The shared PostgreSQL runner gives this file a disposable non-superuser,
 * NOBYPASSRLS database with pgvector available.
 */

import {
  createDatabase,
  type Database,
  eq,
  executeRaw,
  generateId,
  initializeDatabase,
  isPostgresDatabase,
  KnowledgeDocumentRepository,
  type KnowledgeDocumentUnitID,
  KnowledgeNamespaceRepository,
  KnowledgeSemanticSettingsRepository,
  kbDocumentUnits,
  runWithTenantDatabaseScope,
  select,
  sql,
  update,
} from '@agor/core/db';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  type EmbeddingProvider,
  EmbeddingProviderHttpError,
  type EmbeddingResult,
} from '../knowledge/embeddings.js';
import { ensureKnowledgePgvectorStorage } from '../knowledge/pgvector.js';
import { KnowledgeEmbeddingIndexer } from './knowledge-embedding-indexer.js';
import { KnowledgeIndexingStatusService } from './knowledge-indexing.js';

const postgresUrl = process.env.AGOR_TEST_POSTGRES_URL;
const usesPostgresSchema = process.env.AGOR_DB_DIALECT === 'postgresql';
const dimensions = 1536;

interface SeededEmbeddingUnit {
  tenantId: string;
  namespaceId: string;
  documentId: string;
  unitId: KnowledgeDocumentUnitID;
  text: string;
  apiKey: string;
}

function rowsOf(result: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(result)) return result as Array<Record<string, unknown>>;
  const rows = (result as { rows?: unknown[] } | undefined)?.rows;
  return Array.isArray(rows) ? (rows as Array<Record<string, unknown>>) : [];
}

function embeddingResults(
  inputs: Parameters<EmbeddingProvider['embed']>[0],
  model: string,
  value: number
): EmbeddingResult[] {
  return inputs.map((input) => ({
    id: input.id,
    model,
    dimensions,
    embedding: Array.from({ length: dimensions }, () => value),
  }));
}

async function seedEmbeddingUnit(
  db: Database,
  label: string,
  createdAt: Date,
  options: { tenantId?: string; text?: string; apiKey?: string } = {}
): Promise<SeededEmbeddingUnit> {
  const tenantId = options.tenantId ?? `${label}-${generateId()}`;
  const text = options.text ?? `# ${label}\n\nprivate provider input for ${tenantId}`;
  const apiKey = options.apiKey ?? `key-${tenantId}`;
  return runWithTenantDatabaseScope(db, tenantId, async (scoped) => {
    const namespace = await new KnowledgeNamespaceRepository(scoped).create({
      slug: `indexer-${generateId()}`,
      display_name: label,
    });
    const document = await new KnowledgeDocumentRepository(scoped).create({
      namespace_id: namespace.namespace_id,
      path: `${label}.md`,
      title: label,
      content_text: text,
    });
    await new KnowledgeSemanticSettingsRepository(scoped).patch({
      enabled: true,
      provider: 'openai',
      model: 'text-embedding-3-small',
      dimensions,
      indexing: { paused: false, batch_size: 128 },
      api_key: apiKey,
    });
    const unit = await select(scoped)
      .from(kbDocumentUnits)
      .where(eq(kbDocumentUnits.version_id, document.current_version_id!))
      .one();
    await update(scoped, kbDocumentUnits)
      .set({ embedding_status: 'pending', created_at: createdAt, updated_at: new Date() })
      .where(eq(kbDocumentUnits.unit_id, unit!.unit_id))
      .run();
    return {
      tenantId,
      namespaceId: namespace.namespace_id,
      documentId: document.document_id,
      unitId: unit!.unit_id as KnowledgeDocumentUnitID,
      text,
      apiKey,
    };
  });
}

describe.skipIf(!postgresUrl || !usesPostgresSchema)(
  'KnowledgeEmbeddingIndexer two-indexer integration (PostgreSQL)',
  () => {
    let db: Database;
    let storageCapability: Awaited<ReturnType<typeof ensureKnowledgePgvectorStorage>>;
    const originalMasterSecret = process.env.AGOR_MASTER_SECRET;

    beforeAll(async () => {
      process.env.AGOR_MASTER_SECRET = 'knowledge-indexer-postgres-test-secret';
      db = createDatabase({ dialect: 'postgresql', url: postgresUrl! });
      await initializeDatabase(db);
      if (!isPostgresDatabase(db)) throw new Error('PostgreSQL test requires PostgreSQL');
      const [role] = rowsOf(
        await executeRaw(
          db,
          sql`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`
        )
      );
      expect(role).toMatchObject({ rolsuper: false, rolbypassrls: false });
      storageCapability = await runWithTenantDatabaseScope(db, 'storage-bootstrap', (scoped) =>
        ensureKnowledgePgvectorStorage(scoped)
      );
      expect(storageCapability.available).toBe(true);
    }, 60_000);

    afterAll(async () => {
      if (originalMasterSecret === undefined) delete process.env.AGOR_MASTER_SECRET;
      else process.env.AGOR_MASTER_SECRET = originalMasterSecret;
      await (db as Database & { $client: { end: () => Promise<void> } }).$client.end();
    });

    it('races two indexers, commits one vector per unit, and isolates tenant inputs and keys', async () => {
      const tenantA = await seedEmbeddingUnit(db, 'tenant-a', new Date('2030-01-01T00:00:00Z'));
      const tenantB = await seedEmbeddingUnit(db, 'tenant-b', new Date('2030-01-02T00:00:00Z'));
      const calls: Array<{ text: string; apiKey: string; id: string }> = [];
      let releaseCalls!: () => void;
      let bothStarted!: () => void;
      const holdCalls = new Promise<void>((resolve) => {
        releaseCalls = resolve;
      });
      const started = new Promise<void>((resolve) => {
        bothStarted = resolve;
      });
      const provider: EmbeddingProvider = {
        id: 'openai',
        embed: vi.fn(async (inputs, options) => {
          calls.push({ text: inputs[0]!.text, apiKey: options.apiKey, id: inputs[0]!.id });
          if (calls.length === 2) bothStarted();
          await holdCalls;
          return embeddingResults(inputs, options.model, calls.length / 10);
        }),
      };
      const common = {
        distributedMode: true,
        scanBatchSize: 16,
        perTenantBatchSize: 1,
        startupOffsetMaxMs: 0,
        provider,
        ensureStorage: async () => storageCapability,
      };
      const indexerA = new KnowledgeEmbeddingIndexer(db, {
        ...common,
        workIdentity: { instanceId: 'daemon-a', bootId: 'boot-a' },
      });
      const indexerB = new KnowledgeEmbeddingIndexer(db, {
        ...common,
        workIdentity: { instanceId: 'daemon-b', bootId: 'boot-b' },
      });

      const firstScan = indexerA.checkOnce();
      const secondScan = indexerB.checkOnce();
      await started;
      expect(calls).toHaveLength(2);
      releaseCalls();
      const stats = await Promise.all([firstScan, secondScan]);
      expect(stats.reduce((sum, item) => sum + item.indexed, 0)).toBe(2);

      const byId = new Map(calls.map((call) => [call.id, call]));
      expect(byId.get(tenantA.unitId)).toMatchObject({
        text: tenantA.text,
        apiKey: tenantA.apiKey,
      });
      expect(byId.get(tenantB.unitId)).toMatchObject({
        text: tenantB.text,
        apiKey: tenantB.apiKey,
      });

      for (const own of [tenantA, tenantB]) {
        const rows = await runWithTenantDatabaseScope(db, own.tenantId, (scoped) =>
          executeRaw(
            scoped,
            sql`SELECT u.embedding_status, count(e.unit_id)::int AS vector_count
                FROM kb_document_units u
                LEFT JOIN kb_unit_embeddings e ON e.unit_id = u.unit_id
                WHERE u.unit_id = ${own.unitId}
                GROUP BY u.embedding_status`
          )
        );
        expect(rowsOf(rows)[0]).toMatchObject({ embedding_status: 'ready', vector_count: 1 });
      }
      const crossTenant = await runWithTenantDatabaseScope(db, tenantA.tenantId, (scoped) =>
        executeRaw(
          scoped,
          sql`SELECT unit_id FROM kb_document_units WHERE unit_id = ${tenantB.unitId}`
        )
      );
      expect(rowsOf(crossTenant)).toEqual([]);
    });

    it('retains an ambiguous abort, reclaims after expiry, and fences the stale completion', async () => {
      const seeded = await seedEmbeddingUnit(db, 'abort-reclaim', new Date('2031-01-01T00:00:00Z'));
      let releaseFirst!: () => void;
      let firstStarted!: () => void;
      const holdFirst = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      const started = new Promise<void>((resolve) => {
        firstStarted = resolve;
      });
      const observedSignals: AbortSignal[] = [];
      let calls = 0;
      const provider: EmbeddingProvider = {
        id: 'openai',
        embed: vi.fn(async (inputs, options) => {
          calls += 1;
          observedSignals.push(options.signal!);
          if (calls === 1) {
            firstStarted();
            await holdFirst; // Deliberately ignore abort: provider acceptance is ambiguous.
            return embeddingResults(inputs, options.model, 0.25);
          }
          return embeddingResults(inputs, options.model, 0.75);
        }),
      };
      const first = new KnowledgeEmbeddingIndexer(db, {
        tenantId: seeded.tenantId,
        distributedMode: false,
        provider,
        ensureStorage: async () => storageCapability,
        providerTimeoutMs: 1_000,
        claimLeaseMs: 31_000,
        shutdownDrainTimeoutMs: 20,
        workIdentity: { instanceId: 'daemon-crash', bootId: 'boot-crash' },
      });
      first.start();
      await started;
      await first.stop();
      expect(observedSignals[0]?.aborted).toBe(true);

      const retained = await runWithTenantDatabaseScope(db, seeded.tenantId, (scoped) =>
        executeRaw(
          scoped,
          sql`SELECT embedding_claim_token, embedding_claim_generation
              FROM kb_document_units WHERE unit_id = ${seeded.unitId}`
        )
      );
      expect(rowsOf(retained)[0]?.embedding_claim_token).not.toBeNull();
      await runWithTenantDatabaseScope(db, seeded.tenantId, (scoped) =>
        executeRaw(
          scoped,
          sql`UPDATE kb_document_units
              SET embedding_claim_expires_at = clock_timestamp() - interval '1 second'
              WHERE unit_id = ${seeded.unitId}`
        ).then(() => undefined)
      );

      const replacement = new KnowledgeEmbeddingIndexer(db, {
        tenantId: seeded.tenantId,
        distributedMode: false,
        provider,
        ensureStorage: async () => storageCapability,
        workIdentity: { instanceId: 'daemon-replacement', bootId: 'boot-replacement' },
      });
      await expect(replacement.checkOnce()).resolves.toMatchObject({ indexed: 1 });

      const staleRun = (first as unknown as { activeRun: Promise<void> | null }).activeRun;
      releaseFirst();
      await staleRun;
      const committed = await runWithTenantDatabaseScope(db, seeded.tenantId, (scoped) =>
        executeRaw(
          scoped,
          sql`SELECT u.embedding_status, u.embedding_claim_token, e.embedding::text AS embedding
              FROM kb_document_units u
              JOIN kb_unit_embeddings e ON e.unit_id = u.unit_id
              WHERE u.unit_id = ${seeded.unitId}`
        )
      );
      expect(rowsOf(committed)[0]).toMatchObject({
        embedding_status: 'ready',
        embedding_claim_token: null,
      });
      expect(String(rowsOf(committed)[0]?.embedding)).toMatch(/^\[0\.75,/);
      expect(calls).toBe(2);
    });

    it('never seeds embedding reuse from an archived document', async () => {
      const text = '# Shared content\n\nThis exact content must still call the provider.';
      const old = await seedEmbeddingUnit(db, 'reuse-old', new Date('2032-01-01T00:00:00Z'), {
        text,
      });
      const provider: EmbeddingProvider = {
        id: 'openai',
        embed: vi.fn(async (inputs, options) => embeddingResults(inputs, options.model, 0.5)),
      };
      const indexer = new KnowledgeEmbeddingIndexer(db, {
        tenantId: old.tenantId,
        distributedMode: false,
        provider,
        ensureStorage: async () => storageCapability,
      });
      await expect(indexer.checkOnce()).resolves.toMatchObject({ indexed: 1 });
      expect(provider.embed).toHaveBeenCalledTimes(1);

      await runWithTenantDatabaseScope(db, old.tenantId, async (scoped) => {
        // Deliberately isolate the reuse query's document predicate: normal
        // repository deletion also terminalizes the unit and would mask a
        // regression in old_d.archived = false.
        await executeRaw(
          scoped,
          sql`UPDATE kb_documents SET archived = true, archived_at = clock_timestamp()
              WHERE document_id = ${old.documentId}`
        );
        const [source] = rowsOf(
          await executeRaw(
            scoped,
            sql`SELECT n.archived AS namespace_archived,
                       d.archived AS document_archived,
                       u.embedding_status
                FROM kb_document_units u
                JOIN kb_documents d ON d.document_id = u.document_id
                JOIN kb_namespaces n ON n.namespace_id = d.namespace_id
                WHERE u.unit_id = ${old.unitId}`
          )
        );
        expect(source).toMatchObject({
          namespace_archived: false,
          document_archived: true,
          embedding_status: 'ready',
        });
      });
      const current = await seedEmbeddingUnit(
        db,
        'reuse-current',
        new Date('2032-01-02T00:00:00Z'),
        {
          tenantId: old.tenantId,
          text,
          apiKey: old.apiKey,
        }
      );
      await expect(indexer.checkOnce()).resolves.toMatchObject({ indexed: 1 });
      expect(provider.embed).toHaveBeenCalledTimes(2);
      const state = await runWithTenantDatabaseScope(db, old.tenantId, (scoped) =>
        executeRaw(
          scoped,
          sql`SELECT embedding_status FROM kb_document_units WHERE unit_id = ${current.unitId}`
        )
      );
      expect(rowsOf(state)[0]?.embedding_status).toBe('ready');
    });

    it('never seeds embedding reuse from a document in an archived namespace', async () => {
      const text = '# Namespace archive\n\nArchived namespaces cannot seed vector reuse.';
      const old = await seedEmbeddingUnit(
        db,
        'reuse-namespace-old',
        new Date('2032-02-01T00:00:00Z'),
        { text }
      );
      const provider: EmbeddingProvider = {
        id: 'openai',
        embed: vi.fn(async (inputs, options) => embeddingResults(inputs, options.model, 0.6)),
      };
      const indexer = new KnowledgeEmbeddingIndexer(db, {
        tenantId: old.tenantId,
        distributedMode: false,
        provider,
        ensureStorage: async () => storageCapability,
      });
      await expect(indexer.checkOnce()).resolves.toMatchObject({ indexed: 1 });
      expect(provider.embed).toHaveBeenCalledTimes(1);

      await runWithTenantDatabaseScope(db, old.tenantId, async (scoped) => {
        // Deliberately isolate the reuse query's namespace predicate: normal
        // namespace deletion also archives descendants and terminalizes units.
        await executeRaw(
          scoped,
          sql`UPDATE kb_namespaces SET archived = true, archived_at = clock_timestamp()
              WHERE namespace_id = ${old.namespaceId}`
        );
        const [source] = rowsOf(
          await executeRaw(
            scoped,
            sql`SELECT n.archived AS namespace_archived,
                       d.archived AS document_archived,
                       u.embedding_status
                FROM kb_document_units u
                JOIN kb_documents d ON d.document_id = u.document_id
                JOIN kb_namespaces n ON n.namespace_id = d.namespace_id
                WHERE u.unit_id = ${old.unitId}`
          )
        );
        expect(source).toMatchObject({
          namespace_archived: true,
          document_archived: false,
          embedding_status: 'ready',
        });
      });
      const current = await seedEmbeddingUnit(
        db,
        'reuse-namespace-current',
        new Date('2032-02-02T00:00:00Z'),
        {
          tenantId: old.tenantId,
          text,
          apiKey: old.apiKey,
        }
      );
      await expect(indexer.checkOnce()).resolves.toMatchObject({ indexed: 1 });
      expect(provider.embed).toHaveBeenCalledTimes(2);
      const state = await runWithTenantDatabaseScope(db, old.tenantId, (scoped) =>
        executeRaw(
          scoped,
          sql`SELECT embedding_status FROM kb_document_units WHERE unit_id = ${current.unitId}`
        )
      );
      expect(rowsOf(state)[0]?.embedding_status).toBe('ready');
    });

    it('surfaces an operator-gated permanent provider failure in indexing status', async () => {
      const seeded = await seedEmbeddingUnit(
        db,
        'permanent-provider-failure',
        new Date('2033-01-01T00:00:00Z')
      );
      const provider: EmbeddingProvider = {
        id: 'openai',
        embed: vi.fn(async () => {
          throw new EmbeddingProviderHttpError('unauthorized', 401, null, null);
        }),
      };
      const indexer = new KnowledgeEmbeddingIndexer(db, {
        tenantId: seeded.tenantId,
        distributedMode: false,
        provider,
        ensureStorage: async () => storageCapability,
      });

      await expect(indexer.checkOnce()).resolves.toMatchObject({ failures: 1 });
      const status = await runWithTenantDatabaseScope(db, seeded.tenantId, (scoped) =>
        new KnowledgeIndexingStatusService(scoped).find()
      );
      expect(status.chunks.not_configured).toBeGreaterThanOrEqual(1);
      expect(status.queue_depth).toBe(0);
      expect(status.last_error).toContain('unauthorized');
    });
  }
);
