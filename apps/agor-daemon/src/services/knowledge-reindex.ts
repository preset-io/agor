import {
  isPostgresDatabase,
  KnowledgeSemanticSettingsRepository,
  type TenantScopeAwareDatabase,
} from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import type { AuthenticatedParams, KnowledgeEmbeddingStatus, Params } from '@agor/core/types';
import { isUsableOpenAIEmbeddingConfig } from '../knowledge/embeddings.js';
import { ensureKnowledgePgvectorStorage } from '../knowledge/pgvector.js';
import { rebuildCurrentKnowledgeUnits } from '../knowledge/units.js';

export interface KnowledgeReindexResult {
  queued: number;
  status: KnowledgeEmbeddingStatus;
}

export type KnowledgeReindexParams = Params & AuthenticatedParams;

export class KnowledgeReindexService {
  private settings: KnowledgeSemanticSettingsRepository;

  constructor(
    private db: TenantScopeAwareDatabase,
    private app?: Application
  ) {
    this.settings = new KnowledgeSemanticSettingsRepository(db);
  }

  async create(_data?: unknown, _params?: KnowledgeReindexParams): Promise<KnowledgeReindexResult> {
    const semantic = await this.settings.find();
    const embeddingConfigured =
      isPostgresDatabase(this.db) &&
      isUsableOpenAIEmbeddingConfig(semantic, semantic.api_key_configured) &&
      (await ensureKnowledgePgvectorStorage(this.db)).available;
    const status: KnowledgeEmbeddingStatus = embeddingConfigured ? 'pending' : 'not_configured';

    const queued = await rebuildCurrentKnowledgeUnits(this.db, semantic, { embeddingConfigured });

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
