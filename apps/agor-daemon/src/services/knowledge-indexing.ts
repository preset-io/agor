import { loadConfig } from '@agor/core/config';
import {
  AppVariableRepository,
  type Database,
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
import { getKnowledgePgvectorCapability } from '../knowledge/pgvector.js';

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

    const pgvector = await getKnowledgePgvectorCapability(this.db);
    const semanticEnabled = semantic.enabled === true;
    const embeddingConfigUsable = isUsableOpenAIEmbeddingConfig(
      semantic,
      Boolean(apiKey?.value_encrypted)
    );
    const configured = isPostgresDatabase(this.db) && pgvector.available && embeddingConfigUsable;

    const indexer = (this.app as unknown as { get?: (key: string) => unknown } | undefined)?.get?.(
      'knowledgeEmbeddingIndexer'
    ) as { getLastIndexedAt?: () => Date | null; getLastError?: () => string | null } | undefined;
    const lastError = semanticEnabled
      ? ((configured ? indexer?.getLastError?.() : null) ??
        (!pgvector.available ? pgvector.reason : null))
      : null;

    return {
      enabled: semanticEnabled,
      configured,
      dialect: isPostgresDatabase(this.db) ? 'postgresql' : 'sqlite',
      pgvector_available: pgvector.available,
      pgvector_extension_installed: pgvector.extensionInstalled,
      pgvector_storage_ready: pgvector.storageReady,
      pgvector_reason: pgvector.reason,
      pgvector_setup_hint: pgvector.setupHint,
      provider: semantic.provider ?? 'openai',
      model: semantic.model ?? DEFAULT_OPENAI_EMBEDDING_MODEL,
      dimensions: semantic.dimensions ?? DEFAULT_OPENAI_EMBEDDING_DIMENSIONS,
      chunks: counts,
      queue_depth: counts.pending + counts.stale,
      last_indexed_at: indexer?.getLastIndexedAt?.() ?? null,
      last_error: lastError,
    };
  }
}

export function createKnowledgeIndexingStatusService(
  db: Database,
  app?: Application
): KnowledgeIndexingStatusService {
  return new KnowledgeIndexingStatusService(db, app);
}
