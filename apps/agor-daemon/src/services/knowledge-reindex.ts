import { loadConfig } from '@agor/core/config';
import {
  AppVariableRepository,
  isPostgresDatabase,
  type TenantScopeAwareDatabase,
} from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import type { AuthenticatedParams, KnowledgeEmbeddingStatus, Params } from '@agor/core/types';
import {
  isUsableOpenAIEmbeddingConfig,
  KNOWLEDGE_EMBEDDINGS_API_KEY,
  KNOWLEDGE_EMBEDDINGS_NAMESPACE,
} from '../knowledge/embeddings.js';
import { ensureKnowledgePgvectorStorage } from '../knowledge/pgvector.js';
import { rebuildCurrentKnowledgeUnits } from '../knowledge/units.js';

export interface KnowledgeReindexResult {
  queued: number;
  status: KnowledgeEmbeddingStatus;
}

export type KnowledgeReindexParams = Params & AuthenticatedParams;

export class KnowledgeReindexService {
  private variables: AppVariableRepository;

  constructor(
    private db: TenantScopeAwareDatabase,
    private app?: Application
  ) {
    this.variables = new AppVariableRepository(db);
  }

  async create(_data?: unknown, _params?: KnowledgeReindexParams): Promise<KnowledgeReindexResult> {
    const config = await loadConfig();
    const semantic = config.knowledge?.semantic_search ?? {};
    const apiKey = await this.variables.find(
      KNOWLEDGE_EMBEDDINGS_NAMESPACE,
      KNOWLEDGE_EMBEDDINGS_API_KEY
    );
    const embeddingConfigured =
      isPostgresDatabase(this.db) &&
      isUsableOpenAIEmbeddingConfig(semantic, Boolean(apiKey?.value_encrypted)) &&
      (await ensureKnowledgePgvectorStorage(this.db)).available;
    const status: KnowledgeEmbeddingStatus = embeddingConfigured ? 'pending' : 'not_configured';

    const queued = await rebuildCurrentKnowledgeUnits(this.db, config, { embeddingConfigured });

    const indexer = (this.app as unknown as { get?: (key: string) => unknown } | undefined)?.get?.(
      'knowledgeEmbeddingIndexer'
    ) as { wake?: () => void } | undefined;
    if (embeddingConfigured && queued > 0) indexer?.wake?.();

    return { queued, status };
  }
}

export function createKnowledgeReindexService(
  db: TenantScopeAwareDatabase,
  app?: Application
): KnowledgeReindexService {
  return new KnowledgeReindexService(db, app);
}
