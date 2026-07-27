import {
  enqueueAfterTenantDatabaseCommit,
  executeRaw,
  generateId,
  getCurrentTenantId,
  inArray,
  insert,
  isPostgresDatabase,
  KnowledgeSemanticSettingsRepository,
  kbDocumentUnits,
  kbDocumentVersions,
  kbEmbeddingSpaces,
  runWithoutTenantContext,
  runWithoutTenantDatabaseScope,
  runWithTenantContext,
  runWithTenantDatabaseScope,
  select,
  shortId,
  sql,
  type TenantScopeAwareDatabase,
  type TenantScopedDatabase,
  update,
} from '@agor/core/db';
import type { KnowledgeDocumentUnitID, KnowledgeSemanticPolicy, TenantID } from '@agor/core/types';
import {
  DEFAULT_OPENAI_EMBEDDING_DIMENSIONS,
  embeddingToPgvector,
  OpenAIEmbeddingProvider,
  SUPPORTED_OPENAI_EMBEDDING_MODELS,
  sha256Text,
} from '../knowledge/embeddings.js';
import { ensureKnowledgePgvectorStorage } from '../knowledge/pgvector.js';

const DEFAULT_TICK_MS = 30_000;

interface PendingUnitRow {
  unit_id: string;
  document_id: string;
  content_text: string | null;
  content_md5: string | null;
}

interface CurrentUnitRow {
  unit_id: string;
  content_text: string | null;
  content_md5: string | null;
  embedding_status: string;
}

interface ReusedEmbeddingRow {
  unit_id: string;
  new_version_id: string | null;
  previous_version_id: string | null;
}

const EMBEDDING_REUSE_INTO_NEXT_METADATA_KEY = 'embedding_reuse_into_next';

export interface EmbeddingReuseIntoNextMetadataUpdate {
  targetVersionId: string;
  embeddingSpaceId: string;
  provider: string;
  model: string;
  dimensions: number;
  reusedChunks: number;
  totalChunks: number;
  updatedAt: string;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function sameEmbeddingReuseScope(
  existing: Record<string, unknown>,
  update: EmbeddingReuseIntoNextMetadataUpdate
): boolean {
  return (
    existing.target_version_id === update.targetVersionId &&
    existing.embedding_space_id === update.embeddingSpaceId &&
    existing.provider === update.provider &&
    existing.model === update.model &&
    existing.dimensions === update.dimensions
  );
}

export function isKnowledgeEmbeddingMaterializationSnapshotCurrent(
  snapshot: KnowledgeSemanticPolicy,
  current: KnowledgeSemanticPolicy,
  snapshotApiKey: string,
  currentApiKey: string | null
): boolean {
  return (
    snapshotApiKey === currentApiKey &&
    snapshot.enabled === current.enabled &&
    snapshot.provider === current.provider &&
    snapshot.model === current.model &&
    snapshot.dimensions === current.dimensions &&
    snapshot.indexing.paused === current.indexing.paused &&
    JSON.stringify(snapshot.chunking) === JSON.stringify(current.chunking)
  );
}

export function mergeEmbeddingReuseIntoNextMetadata(
  metadata: Record<string, unknown> | null | undefined,
  update: EmbeddingReuseIntoNextMetadataUpdate
): Record<string, unknown> {
  const existingMetadata = asRecord(metadata);
  const existingReuse = asRecord(existingMetadata[EMBEDDING_REUSE_INTO_NEXT_METADATA_KEY]);
  const previousReused = sameEmbeddingReuseScope(existingReuse, update)
    ? Number(existingReuse.reused_chunks) || 0
    : 0;

  return {
    ...existingMetadata,
    [EMBEDDING_REUSE_INTO_NEXT_METADATA_KEY]: {
      target_version_id: update.targetVersionId,
      embedding_space_id: update.embeddingSpaceId,
      provider: update.provider,
      model: update.model,
      dimensions: update.dimensions,
      reused_chunks: Math.min(update.totalChunks, previousReused + update.reusedChunks),
      total_chunks: update.totalChunks,
      updated_at: update.updatedAt,
    },
  };
}

export interface KnowledgeEmbeddingReuseSqlParams {
  embeddingSpaceId: string;
  model: string;
  dimensions: number;
  limit: number;
}

export function buildKnowledgeEmbeddingReuseSql(params: KnowledgeEmbeddingReuseSqlParams) {
  return sql`WITH pending AS (
            SELECT unit_id, version_id, content_md5
            FROM kb_document_units
            WHERE embedding_status IN ('pending', 'stale')
              AND content_text IS NOT NULL
              AND content_md5 IS NOT NULL
            ORDER BY created_at
            LIMIT ${params.limit}
          ), candidates AS (
            SELECT DISTINCT ON (p.unit_id)
              p.unit_id AS new_unit_id,
              p.version_id AS new_version_id,
              prev_v.version_id AS previous_version_id,
              e.content_sha256,
              p.content_md5 AS new_embedding_hash,
              e.embedding,
              e.token_count
            FROM pending p
            JOIN kb_document_versions new_v
              ON new_v.version_id = p.version_id
            LEFT JOIN kb_document_versions prev_v
              ON prev_v.document_id = new_v.document_id
             AND prev_v.version_number = new_v.version_number - 1
            JOIN kb_document_units old_u
              ON old_u.content_md5 = p.content_md5
             AND old_u.unit_id <> p.unit_id
             AND old_u.embedding_status = 'ready'
             AND old_u.embedding_model = ${params.model}
             AND old_u.embedding_dimensions = ${params.dimensions}
            JOIN kb_unit_embeddings e
              ON e.unit_id = old_u.unit_id
             AND e.embedding_space_id = ${params.embeddingSpaceId}
            ORDER BY p.unit_id, old_u.updated_at DESC NULLS LAST, old_u.created_at DESC
          ), upserted AS (
            INSERT INTO kb_unit_embeddings (
              tenant_id,
              unit_id,
              embedding_space_id,
              content_sha256,
              embedding,
              token_count,
              created_at,
              updated_at
            )
            SELECT
              COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default'),
              new_unit_id,
              ${params.embeddingSpaceId},
              content_sha256,
              embedding,
              token_count,
              now(),
              now()
            FROM candidates
            ON CONFLICT (unit_id, embedding_space_id) DO UPDATE SET
              content_sha256 = EXCLUDED.content_sha256,
              embedding = EXCLUDED.embedding,
              token_count = EXCLUDED.token_count,
              updated_at = now()
            RETURNING unit_id
          )
          UPDATE kb_document_units u
          SET embedding_status = 'ready',
              embedding_model = ${params.model},
              embedding_dimensions = ${params.dimensions},
              embedding_hash = candidates.new_embedding_hash,
              embedding_error = NULL,
              updated_at = now()
          FROM upserted
          JOIN candidates ON candidates.new_unit_id = upserted.unit_id
          WHERE u.unit_id = upserted.unit_id
          RETURNING
            u.unit_id,
            candidates.new_version_id,
            candidates.previous_version_id`;
}

export class KnowledgeEmbeddingIndexer {
  private intervalHandle?: NodeJS.Timeout;
  private running = false;
  private wakeScheduled = false;
  private rerunRequested = false;
  private settings: KnowledgeSemanticSettingsRepository;
  private provider = new OpenAIEmbeddingProvider();
  private lastErrorByTenant = new Map<string, string | null>();
  private lastIndexedAtByTenant = new Map<string, Date>();
  private pgvectorStorageReady = false;

  constructor(
    private db: TenantScopeAwareDatabase,
    private options: { tenantId?: TenantID | string } = {}
  ) {
    this.settings = new KnowledgeSemanticSettingsRepository(db);
  }

  private withTenantDatabase<T>(work: (db: TenantScopedDatabase) => Promise<T>): Promise<T> {
    return runWithTenantDatabaseScope(this.db, getCurrentTenantId(), work);
  }

  start(): void {
    if (this.intervalHandle) return;
    this.intervalHandle = setInterval(() => {
      this.tick().catch((error) => {
        console.error('[knowledge-indexer] tick failed:', error);
      });
    }, DEFAULT_TICK_MS);
    this.wake();
  }

  stop(): void {
    if (this.intervalHandle) clearInterval(this.intervalHandle);
    this.intervalHandle = undefined;
  }

  wake(): void {
    const schedule = () => {
      // Timers inherit AsyncLocalStorage. Explicitly detach both the request's
      // operation identity and its (possibly committed) transaction before the
      // indexer establishes its own tenant context in tick().
      runWithoutTenantContext(() => {
        runWithoutTenantDatabaseScope(() => {
          if (this.running) {
            this.rerunRequested = true;
            return;
          }
          if (this.wakeScheduled) return;
          this.wakeScheduled = true;
          setTimeout(() => {
            this.wakeScheduled = false;
            this.tick().catch((error) => {
              console.error('[knowledge-indexer] wake failed:', error);
            });
          }, 0);
        });
      });
    };

    // A settings/document mutation can call wake from an outer tenant
    // transaction. Never let the indexer observe work until that transaction
    // commits; rollback discards the callback.
    if (!enqueueAfterTenantDatabaseCommit(schedule)) schedule();
  }

  private currentTenantKey(): string {
    return String(getCurrentTenantId() ?? this.options.tenantId ?? 'default');
  }

  getLastError(tenantId?: TenantID | string): string | null {
    return this.lastErrorByTenant.get(String(tenantId ?? this.currentTenantKey())) ?? null;
  }

  getLastIndexedAt(tenantId?: TenantID | string): Date | null {
    return this.lastIndexedAtByTenant.get(String(tenantId ?? this.currentTenantKey())) ?? null;
  }

  private idle(): 0 {
    this.lastErrorByTenant.set(this.currentTenantKey(), null);
    return 0;
  }

  private async ensureEmbeddingSpace(params: {
    provider: string;
    model: string;
    dimensions: number;
  }): Promise<string> {
    const existing = await select(this.db)
      .from(kbEmbeddingSpaces)
      .where(
        sql`${kbEmbeddingSpaces.provider} = ${params.provider} AND ${kbEmbeddingSpaces.model} = ${params.model} AND ${kbEmbeddingSpaces.dimensions} = ${params.dimensions} AND ${kbEmbeddingSpaces.storage_type} = 'vector' AND ${kbEmbeddingSpaces.distance} = 'cosine'`
      )
      .limit(1)
      .one();
    if (existing?.embedding_space_id) return existing.embedding_space_id as string;

    const embeddingSpaceId = generateId();
    await insert(this.db, kbEmbeddingSpaces)
      .values({
        embedding_space_id: embeddingSpaceId,
        provider: params.provider,
        model: params.model,
        dimensions: params.dimensions,
        storage_type: 'vector',
        distance: 'cosine',
        active: true,
        metadata: null,
        created_at: new Date(),
        updated_at: new Date(),
      })
      .run();
    return embeddingSpaceId;
  }

  private rawRows(result: unknown): Array<Record<string, unknown>> {
    if (Array.isArray(result)) return result as Array<Record<string, unknown>>;
    const rows = (result as { rows?: unknown[] } | undefined)?.rows;
    return Array.isArray(rows) ? (rows as Array<Record<string, unknown>>) : [];
  }

  /**
   * Reattach vector rows for byte-identical normalized chunks before calling
   * the embedding provider. Reuse is scoped to the exact embedding space id
   * (provider + model + dimensions + storage/distance), so a model or
   * provider change leaves chunks pending for fresh embeddings.
   *
   * `kb_unit_embeddings.content_sha256` records the exact text that produced
   * the stored vector. During normalized-hash reuse this may intentionally
   * differ from the new unit's byte-level content. `embedding_hash` is always
   * set to the pending unit's normalized chunk hash (`content_md5`) so reused
   * and freshly embedded units have consistent staleness metadata.
   */
  private async reuseExistingEmbeddings(params: {
    embeddingSpaceId: string;
    model: string;
    dimensions: number;
    limit: number;
  }): Promise<ReusedEmbeddingRow[]> {
    const result = await executeRaw(this.db, buildKnowledgeEmbeddingReuseSql(params));
    return this.rawRows(result).map((row) => ({
      unit_id: String(row.unit_id ?? ''),
      new_version_id: row.new_version_id ? String(row.new_version_id) : null,
      previous_version_id: row.previous_version_id ? String(row.previous_version_id) : null,
    }));
  }

  private async recordEmbeddingReuseIntoNext(params: {
    rows: ReusedEmbeddingRow[];
    embeddingSpaceId: string;
    provider: string;
    model: string;
    dimensions: number;
  }): Promise<void> {
    const countsByPair = new Map<
      string,
      { previousVersionId: string; targetVersionId: string; reusedChunks: number }
    >();
    for (const row of params.rows) {
      if (!row.previous_version_id || !row.new_version_id) continue;
      const key = `${row.previous_version_id}:${row.new_version_id}`;
      const current = countsByPair.get(key) ?? {
        previousVersionId: row.previous_version_id,
        targetVersionId: row.new_version_id,
        reusedChunks: 0,
      };
      current.reusedChunks += 1;
      countsByPair.set(key, current);
    }
    if (countsByPair.size === 0) return;

    const targetVersionIds = [
      ...new Set([...countsByPair.values()].map((item) => item.targetVersionId)),
    ];
    const totalRows = (await select(this.db, {
      version_id: kbDocumentUnits.version_id,
      count: sql<number>`count(*)`,
    })
      .from(kbDocumentUnits)
      .where(inArray(kbDocumentUnits.version_id, targetVersionIds))
      .groupBy(kbDocumentUnits.version_id)
      .all()) as Array<{ version_id: string; count: number | string }>;
    const totalByVersion = new Map(
      totalRows.map((row) => [row.version_id, Number(row.count) || 0])
    );

    const previousVersionIds = [
      ...new Set([...countsByPair.values()].map((item) => item.previousVersionId)),
    ];
    const previousRows = (await select(this.db)
      .from(kbDocumentVersions)
      .where(inArray(kbDocumentVersions.version_id, previousVersionIds))
      .all()) as Array<typeof kbDocumentVersions.$inferSelect>;
    const previousById = new Map(previousRows.map((row) => [row.version_id, row]));
    const updatedAt = new Date().toISOString();

    for (const item of countsByPair.values()) {
      const previous = previousById.get(item.previousVersionId);
      if (!previous) continue;
      const metadata = mergeEmbeddingReuseIntoNextMetadata(
        previous.metadata as Record<string, unknown> | null,
        {
          targetVersionId: item.targetVersionId,
          embeddingSpaceId: params.embeddingSpaceId,
          provider: params.provider,
          model: params.model,
          dimensions: params.dimensions,
          reusedChunks: item.reusedChunks,
          totalChunks: totalByVersion.get(item.targetVersionId) ?? 0,
          updatedAt,
        }
      );
      await update(this.db, kbDocumentVersions)
        .set({ metadata })
        .where(sql`${kbDocumentVersions.version_id} = ${item.previousVersionId}`)
        .run();
    }
  }

  async tick(): Promise<void> {
    if (this.options.tenantId) {
      return runWithTenantContext(this.options.tenantId, () => this.tickInScope());
    }
    return this.tickInScope();
  }

  private async tickInScope(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const indexed = await this.indexBatch();
      if (indexed > 0 || !this.getLastError()) {
        this.lastErrorByTenant.set(this.currentTenantKey(), null);
      }
    } catch (error) {
      this.lastErrorByTenant.set(
        this.currentTenantKey(),
        error instanceof Error ? error.message : String(error)
      );
      throw error;
    } finally {
      this.running = false;
      if (this.rerunRequested) {
        this.rerunRequested = false;
        this.wake();
      }
    }
  }

  async indexBatch(): Promise<number> {
    const { semantic, apiKey } = await this.withTenantDatabase(async () => ({
      semantic: await this.settings.findPolicy(),
      apiKey: await this.settings.getApiKey(),
    }));
    if (!semantic.enabled) return this.idle();
    if (semantic.indexing.paused) return this.idle();
    if (!isPostgresDatabase(this.db)) return this.idle();
    const provider = semantic.provider;
    if (provider !== 'openai') return this.idle();
    if (!apiKey) return this.idle();

    const model = semantic.model;
    if (!SUPPORTED_OPENAI_EMBEDDING_MODELS.has(model)) {
      throw new Error(`Unsupported OpenAI embedding model: ${model}`);
    }
    const dimensions = semantic.dimensions;
    if (dimensions !== DEFAULT_OPENAI_EMBEDDING_DIMENSIONS) {
      throw new Error(
        'Only 1536-dimensional OpenAI embeddings are supported by the V1 vector table'
      );
    }

    const batchSize = Math.min(Math.max(semantic.indexing.batch_size, 1), 128);
    this.lastErrorByTenant.set(this.currentTenantKey(), null);
    const prepared = await this.withTenantDatabase(async (tx) => {
      const currentSemantic = await this.settings.lockAggregateForUpdate(tx);
      const currentApiKey = await this.settings.getApiKey();
      if (
        !isKnowledgeEmbeddingMaterializationSnapshotCurrent(
          semantic,
          currentSemantic,
          apiKey,
          currentApiKey
        )
      ) {
        return { kind: 'obsolete' as const };
      }

      // Hot idle path: avoid provider setup/work when no units are pending.
      const pending = (await select(this.db, { unit_id: kbDocumentUnits.unit_id })
        .from(kbDocumentUnits)
        .where(
          sql`${kbDocumentUnits.embedding_status} IN ('pending', 'stale') AND ${kbDocumentUnits.content_text} IS NOT NULL`
        )
        .orderBy(kbDocumentUnits.created_at)
        .limit(1)
        .one()) as { unit_id: string } | undefined;
      if (!pending) return { kind: 'idle' as const };

      if (!this.pgvectorStorageReady) {
        const pgvector = await ensureKnowledgePgvectorStorage(this.db);
        if (!pgvector.available) {
          return {
            kind: 'unavailable' as const,
            reason: pgvector.reason ?? 'Knowledge pgvector storage is unavailable',
          };
        }
        this.pgvectorStorageReady = true;
      }

      const embeddingSpaceId = await this.ensureEmbeddingSpace({ provider, model, dimensions });
      const reusedRows = await this.reuseExistingEmbeddings({
        embeddingSpaceId,
        model,
        dimensions,
        limit: batchSize,
      });
      await this.recordEmbeddingReuseIntoNext({
        rows: reusedRows,
        embeddingSpaceId,
        provider,
        model,
        dimensions,
      });
      const reused = reusedRows.length;
      const rows = (await select(this.db)
        .from(kbDocumentUnits)
        .where(
          sql`${kbDocumentUnits.embedding_status} IN ('pending', 'stale') AND ${kbDocumentUnits.content_text} IS NOT NULL`
        )
        .orderBy(kbDocumentUnits.created_at)
        .limit(batchSize)
        .all()) as PendingUnitRow[];
      return { kind: 'ready' as const, embeddingSpaceId, reused, rows };
    });
    if (prepared.kind === 'obsolete') return 0;
    if (prepared.kind === 'idle') return this.idle();
    if (prepared.kind === 'unavailable') {
      this.lastErrorByTenant.set(this.currentTenantKey(), prepared.reason);
      return 0;
    }
    const { embeddingSpaceId, reused, rows } = prepared;
    if (rows.length === 0) {
      if (reused === 0) return this.idle();
      this.lastIndexedAtByTenant.set(this.currentTenantKey(), new Date());
      return reused;
    }

    const chunksByDocument = new Map<string, number>();
    let totalChars = 0;
    for (const row of rows) {
      chunksByDocument.set(row.document_id, (chunksByDocument.get(row.document_id) ?? 0) + 1);
      totalChars += row.content_text?.length ?? 0;
    }
    const docSummary = [...chunksByDocument.entries()]
      .slice(0, 5)
      .map(([documentId, count]) => `${shortId(documentId)}=${count}`)
      .join(', ');
    const extraDocs = Math.max(0, chunksByDocument.size - 5);
    console.info(
      `[knowledge-indexer] Computing ${rows.length} embedding chunk(s) across ${
        chunksByDocument.size
      } document(s) (${docSummary}${extraDocs > 0 ? `, +${extraDocs} more` : ''}); ` +
        `model=${model}, dimensions=${dimensions}, chars=${totalChars}`
    );

    let results: Awaited<ReturnType<OpenAIEmbeddingProvider['embed']>>;
    try {
      results = await this.provider.embed(
        rows.map((row) => ({
          id: row.unit_id,
          text: row.content_text ?? '',
          inputType: 'document',
        })),
        { apiKey, model, dimensions }
      );
    } catch (error) {
      const recorded = await this.withTenantDatabase(async (tx) => {
        const currentSemantic = await this.settings.lockAggregateForUpdate(tx);
        const currentApiKey = await this.settings.getApiKey();
        if (
          !isKnowledgeEmbeddingMaterializationSnapshotCurrent(
            semantic,
            currentSemantic,
            apiKey,
            currentApiKey
          )
        ) {
          return false;
        }
        const eligibleIds = await this.eligibleResultUnitIds(rows);
        if (eligibleIds.length === 0) return false;
        await update(this.db, kbDocumentUnits)
          .set({
            embedding_status: 'error',
            embedding_error: error instanceof Error ? error.message : String(error),
            updated_at: new Date(),
          })
          .where(inArray(kbDocumentUnits.unit_id, eligibleIds as KnowledgeDocumentUnitID[]))
          .run();
        return true;
      });
      if (!recorded) return 0;
      throw error;
    }

    const committed = await this.withTenantDatabase(async (tx) => {
      const currentSemantic = await this.settings.lockAggregateForUpdate(tx);
      const currentApiKey = await this.settings.getApiKey();
      if (
        !isKnowledgeEmbeddingMaterializationSnapshotCurrent(
          semantic,
          currentSemantic,
          apiKey,
          currentApiKey
        )
      ) {
        return 0;
      }

      const eligibleIds = new Set(await this.eligibleResultUnitIds(rows));
      const currentResults = results.filter((result) => eligibleIds.has(result.id));
      if (currentResults.length === 0) return 0;
      for (const result of currentResults) {
        const source = rows.find((row) => row.unit_id === result.id);
        const content = source?.content_text ?? '';
        const vector = embeddingToPgvector(result.embedding);
        await executeRaw(
          this.db,
          sql`INSERT INTO kb_unit_embeddings (tenant_id, unit_id, embedding_space_id, content_sha256, embedding, token_count, created_at, updated_at)
            VALUES (COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default'), ${result.id}, ${embeddingSpaceId}, ${sha256Text(content)}, ${vector}::vector, ${result.tokenCount ?? null}, now(), now())
            ON CONFLICT (unit_id, embedding_space_id) DO UPDATE SET
              content_sha256 = EXCLUDED.content_sha256,
              embedding = EXCLUDED.embedding,
              token_count = EXCLUDED.token_count,
              updated_at = now()`
        );
      }

      await update(this.db, kbDocumentUnits)
        .set({
          embedding_status: 'ready',
          embedding_model: model,
          embedding_dimensions: dimensions,
          embedding_hash: sql`${kbDocumentUnits.content_md5}`,
          embedding_error: null,
          updated_at: new Date(),
        })
        .where(
          inArray(
            kbDocumentUnits.unit_id,
            currentResults.map((result) => result.id as KnowledgeDocumentUnitID)
          )
        )
        .run();
      return currentResults.length;
    });

    if (committed === 0) return 0;
    this.lastIndexedAtByTenant.set(this.currentTenantKey(), new Date());
    return reused + committed;
  }

  private async eligibleResultUnitIds(rows: PendingUnitRow[]): Promise<string[]> {
    if (rows.length === 0) return [];
    const currentRows = (await select(this.db, {
      unit_id: kbDocumentUnits.unit_id,
      content_text: kbDocumentUnits.content_text,
      content_md5: kbDocumentUnits.content_md5,
      embedding_status: kbDocumentUnits.embedding_status,
    })
      .from(kbDocumentUnits)
      .where(
        inArray(
          kbDocumentUnits.unit_id,
          rows.map((row) => row.unit_id as KnowledgeDocumentUnitID)
        )
      )
      .all()) as CurrentUnitRow[];
    const sourceById = new Map(rows.map((row) => [row.unit_id, row]));
    return currentRows
      .filter((row) => {
        const source = sourceById.get(row.unit_id);
        return (
          source !== undefined &&
          source.content_text === row.content_text &&
          source.content_md5 === row.content_md5 &&
          (row.embedding_status === 'pending' || row.embedding_status === 'stale')
        );
      })
      .map((row) => row.unit_id);
  }
}
