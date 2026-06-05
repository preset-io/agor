import { loadConfig } from '@agor/core/config';
import {
  AppVariableRepository,
  type Database,
  executeRaw,
  isPostgresDatabase,
  kbDocumentUnits,
  select,
  sql,
} from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import type {
  AuthenticatedParams,
  KnowledgeEmbeddingStatus,
  KnowledgeIndexingStatus,
  Params,
} from '@agor/core/types';
import {
  DEFAULT_OPENAI_EMBEDDING_DIMENSIONS,
  DEFAULT_OPENAI_EMBEDDING_MODEL,
  isUsableOpenAIEmbeddingConfig,
  KNOWLEDGE_EMBEDDINGS_API_KEY,
  KNOWLEDGE_EMBEDDINGS_NAMESPACE,
} from '../knowledge/embeddings.js';

const STATUSES: KnowledgeEmbeddingStatus[] = [
  'not_configured',
  'pending',
  'ready',
  'stale',
  'error',
];

export type KnowledgeIndexingParams = Params & AuthenticatedParams;

export class KnowledgeIndexingStatusService {
  private variables: AppVariableRepository;

  constructor(
    private db: Database,
    private app?: Application
  ) {
    this.variables = new AppVariableRepository(db);
  }

  async find(_params?: KnowledgeIndexingParams): Promise<KnowledgeIndexingStatus> {
    const config = await loadConfig();
    const semantic = config.knowledge?.semantic_search ?? {};
    const apiKey = await this.variables.find(
      KNOWLEDGE_EMBEDDINGS_NAMESPACE,
      KNOWLEDGE_EMBEDDINGS_API_KEY
    );
    const counts = Object.fromEntries(STATUSES.map((status) => [status, 0])) as Record<
      KnowledgeEmbeddingStatus,
      number
    >;

    const rows = await select(this.db, {
      status: kbDocumentUnits.embedding_status,
      count: sql<number>`count(*)`,
    })
      .from(kbDocumentUnits)
      .groupBy(kbDocumentUnits.embedding_status)
      .all();
    for (const row of rows as Array<{ status: KnowledgeEmbeddingStatus; count: number | string }>) {
      counts[row.status] = Number(row.count) || 0;
    }

    let pgvectorAvailable = false;
    if (isPostgresDatabase(this.db)) {
      try {
        const pgvectorRows = await executeRaw(
          this.db,
          sql`SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') AS available`
        );
        const first = pgvectorRows.rows?.[0] as { available?: boolean } | undefined;
        pgvectorAvailable = Boolean(first?.available);
      } catch {
        pgvectorAvailable = false;
      }
    }

    const indexer = (this.app as unknown as { get?: (key: string) => unknown } | undefined)?.get?.(
      'knowledgeEmbeddingIndexer'
    ) as { getLastIndexedAt?: () => Date | null; getLastError?: () => string | null } | undefined;

    return {
      enabled: semantic.enabled === true,
      configured:
        isPostgresDatabase(this.db) &&
        pgvectorAvailable &&
        isUsableOpenAIEmbeddingConfig(semantic, Boolean(apiKey?.value_encrypted)),
      dialect: isPostgresDatabase(this.db) ? 'postgresql' : 'sqlite',
      pgvector_available: pgvectorAvailable,
      provider: semantic.provider ?? 'openai',
      model: semantic.model ?? DEFAULT_OPENAI_EMBEDDING_MODEL,
      dimensions: semantic.dimensions ?? DEFAULT_OPENAI_EMBEDDING_DIMENSIONS,
      chunks: counts,
      queue_depth: counts.pending + counts.stale,
      last_indexed_at: indexer?.getLastIndexedAt?.() ?? null,
      last_error: indexer?.getLastError?.() ?? null,
    };
  }
}

export function createKnowledgeIndexingStatusService(
  db: Database,
  app?: Application
): KnowledgeIndexingStatusService {
  return new KnowledgeIndexingStatusService(db, app);
}
