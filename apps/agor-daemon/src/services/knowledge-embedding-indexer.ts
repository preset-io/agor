import { loadConfig } from '@agor/core/config';
import {
  AppVariableRepository,
  type Database,
  executeRaw,
  generateId,
  inArray,
  insert,
  isPostgresDatabase,
  kbDocumentUnits,
  kbEmbeddingSpaces,
  select,
  sql,
  update,
} from '@agor/core/db';
import type { KnowledgeDocumentUnitID } from '@agor/core/types';
import {
  DEFAULT_OPENAI_EMBEDDING_DIMENSIONS,
  DEFAULT_OPENAI_EMBEDDING_MODEL,
  embeddingToPgvector,
  KNOWLEDGE_EMBEDDINGS_API_KEY,
  KNOWLEDGE_EMBEDDINGS_NAMESPACE,
  OpenAIEmbeddingProvider,
  SUPPORTED_OPENAI_EMBEDDING_MODELS,
  sha256Text,
} from '../knowledge/embeddings.js';
import { ensureKnowledgePgvectorStorage } from '../knowledge/pgvector.js';

const DEFAULT_TICK_MS = 30_000;

interface PendingUnitRow {
  unit_id: string;
  content_text: string | null;
  content_md5: string | null;
}

export class KnowledgeEmbeddingIndexer {
  private intervalHandle?: NodeJS.Timeout;
  private running = false;
  private wakeScheduled = false;
  private variables: AppVariableRepository;
  private provider = new OpenAIEmbeddingProvider();
  private lastError: string | null = null;
  private lastIndexedAt: Date | null = null;

  constructor(private db: Database) {
    this.variables = new AppVariableRepository(db);
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
    if (this.wakeScheduled) return;
    this.wakeScheduled = true;
    setTimeout(() => {
      this.wakeScheduled = false;
      this.tick().catch((error) => {
        console.error('[knowledge-indexer] wake failed:', error);
      });
    }, 0);
  }

  getLastError(): string | null {
    return this.lastError;
  }

  getLastIndexedAt(): Date | null {
    return this.lastIndexedAt;
  }

  private idle(): 0 {
    this.lastError = null;
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

  private mutationCount(result: unknown): number {
    const rowCount = (result as { rowCount?: unknown } | undefined)?.rowCount;
    if (typeof rowCount === 'number') return rowCount;
    const count = (result as { count?: unknown } | undefined)?.count;
    if (typeof count === 'number') return count;
    return this.rawRows(result).length;
  }

  /**
   * Reattach vector rows for byte-identical normalized chunks before calling
   * the embedding provider. Reuse is scoped to the exact embedding space id
   * (provider + model + dimensions + storage/distance), so a model or
   * provider change leaves chunks pending for fresh embeddings.
   */
  private async reuseExistingEmbeddings(params: {
    embeddingSpaceId: string;
    model: string;
    dimensions: number;
    limit: number;
  }): Promise<number> {
    const result = await executeRaw(
      this.db,
      sql`WITH pending AS (
            SELECT unit_id, content_md5
            FROM kb_document_units
            WHERE embedding_status IN ('pending', 'stale')
              AND content_text IS NOT NULL
              AND content_md5 IS NOT NULL
            ORDER BY created_at
            LIMIT ${params.limit}
          ), candidates AS (
            SELECT DISTINCT ON (p.unit_id)
              p.unit_id AS new_unit_id,
              e.content_sha256,
              old_u.embedding_hash,
              e.embedding,
              e.token_count
            FROM pending p
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
              unit_id,
              embedding_space_id,
              content_sha256,
              embedding,
              token_count,
              created_at,
              updated_at
            )
            SELECT
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
              embedding_hash = COALESCE(candidates.embedding_hash, candidates.content_sha256),
              embedding_error = NULL,
              updated_at = now()
          FROM upserted
          JOIN candidates ON candidates.new_unit_id = upserted.unit_id
          WHERE u.unit_id = upserted.unit_id
          RETURNING u.unit_id`
    );
    return this.mutationCount(result);
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const indexed = await this.indexBatch();
      if (indexed > 0 || !this.lastError) this.lastError = null;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      this.running = false;
    }
  }

  async indexBatch(): Promise<number> {
    const config = await loadConfig();
    const semantic = config.knowledge?.semantic_search;
    if (semantic?.enabled !== true) return this.idle();
    if (semantic.indexing?.paused === true) return this.idle();
    if (!isPostgresDatabase(this.db)) return this.idle();
    const provider = semantic.provider ?? 'openai';
    if (provider !== 'openai') return this.idle();

    const apiKey = await this.variables.getPlain(
      KNOWLEDGE_EMBEDDINGS_NAMESPACE,
      KNOWLEDGE_EMBEDDINGS_API_KEY
    );
    if (!apiKey) return this.idle();

    const model = semantic.model ?? DEFAULT_OPENAI_EMBEDDING_MODEL;
    if (!SUPPORTED_OPENAI_EMBEDDING_MODELS.has(model)) {
      throw new Error(`Unsupported OpenAI embedding model: ${model}`);
    }
    const dimensions = semantic.dimensions ?? DEFAULT_OPENAI_EMBEDDING_DIMENSIONS;
    if (dimensions !== DEFAULT_OPENAI_EMBEDDING_DIMENSIONS) {
      throw new Error(
        'Only 1536-dimensional OpenAI embeddings are supported by the V1 vector table'
      );
    }

    const pgvector = await ensureKnowledgePgvectorStorage(this.db);
    if (!pgvector.available) {
      this.lastError = pgvector.reason ?? 'Knowledge pgvector storage is unavailable';
      return 0;
    }

    const batchSize = Math.min(Math.max(semantic.indexing?.batch_size ?? 32, 1), 128);
    this.lastError = null;

    const embeddingSpaceId = await this.ensureEmbeddingSpace({ provider, model, dimensions });
    const reused = await this.reuseExistingEmbeddings({
      embeddingSpaceId,
      model,
      dimensions,
      limit: batchSize,
    });

    const rows = (await select(this.db)
      .from(kbDocumentUnits)
      .where(
        sql`${kbDocumentUnits.embedding_status} IN ('pending', 'stale') AND ${kbDocumentUnits.content_text} IS NOT NULL`
      )
      .orderBy(kbDocumentUnits.created_at)
      .limit(batchSize)
      .all()) as PendingUnitRow[];
    if (rows.length === 0) {
      if (reused === 0) return this.idle();
      this.lastIndexedAt = new Date();
      return reused;
    }

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
      await update(this.db, kbDocumentUnits)
        .set({
          embedding_status: 'error',
          embedding_error: error instanceof Error ? error.message : String(error),
          updated_at: new Date(),
        })
        .where(
          inArray(
            kbDocumentUnits.unit_id,
            rows.map((row) => row.unit_id as KnowledgeDocumentUnitID)
          )
        )
        .run();
      throw error;
    }

    for (const result of results) {
      const source = rows.find((row) => row.unit_id === result.id);
      const content = source?.content_text ?? '';
      const vector = embeddingToPgvector(result.embedding);
      await executeRaw(
        this.db,
        sql`INSERT INTO kb_unit_embeddings (unit_id, embedding_space_id, content_sha256, embedding, token_count, created_at, updated_at)
            VALUES (${result.id}, ${embeddingSpaceId}, ${sha256Text(content)}, ${vector}::vector, ${result.tokenCount ?? null}, now(), now())
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
          results.map((result) => result.id as KnowledgeDocumentUnitID)
        )
      )
      .run();

    this.lastIndexedAt = new Date();
    return reused + results.length;
  }
}
