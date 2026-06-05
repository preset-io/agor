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

    const rows = (await select(this.db)
      .from(kbDocumentUnits)
      .where(
        sql`${kbDocumentUnits.embedding_status} IN ('pending', 'stale') AND ${kbDocumentUnits.content_text} IS NOT NULL`
      )
      .orderBy(kbDocumentUnits.created_at)
      .limit(batchSize)
      .all()) as PendingUnitRow[];
    if (rows.length === 0) return this.idle();

    const embeddingSpaceId = await this.ensureEmbeddingSpace({ provider, model, dimensions });
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
    return results.length;
  }
}
