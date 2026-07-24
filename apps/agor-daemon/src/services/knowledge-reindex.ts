import {
  isPostgresDatabase,
  KnowledgeSemanticSettingsRepository,
  type TenantScopeAwareDatabase,
  type TenantScopedDatabase,
} from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import type { AuthenticatedParams, KnowledgeEmbeddingStatus, Params } from '@agor/core/types';
import { isUsableOpenAIEmbeddingConfig } from '../knowledge/embeddings.js';
import { ensureKnowledgePgvectorStorage } from '../knowledge/pgvector.js';
import { runKnowledgePolicyTransaction } from '../knowledge/policy-transaction.js';
import { rebuildCurrentKnowledgeUnits } from '../knowledge/units.js';

export interface KnowledgeReindexResult {
  queued: number;
  status: KnowledgeEmbeddingStatus;
}

export type KnowledgeReindexParams = Params & AuthenticatedParams;

export class KnowledgeReindexService {
  constructor(
    private db: TenantScopeAwareDatabase,
    private app?: Application
  ) {}

  private async reindexInTransaction(db: TenantScopedDatabase): Promise<KnowledgeReindexResult> {
    const semantic = await new KnowledgeSemanticSettingsRepository(db).lockAggregateForUpdate(db);
    const embeddingConfigured =
      isPostgresDatabase(db) &&
      isUsableOpenAIEmbeddingConfig(semantic, semantic.api_key_configured) &&
      (await ensureKnowledgePgvectorStorage(db)).available;
    const status: KnowledgeEmbeddingStatus = embeddingConfigured ? 'pending' : 'not_configured';

    const queued = await rebuildCurrentKnowledgeUnits(db, semantic, { embeddingConfigured });

    return { queued, status };
  }

  async create(_data?: unknown, _params?: KnowledgeReindexParams): Promise<KnowledgeReindexResult> {
    const result = await runKnowledgePolicyTransaction(this.db, (tx) =>
      this.reindexInTransaction(tx)
    );

    const indexer = (this.app as unknown as { get?: (key: string) => unknown } | undefined)?.get?.(
      'knowledgeEmbeddingIndexer'
    ) as { wake?: () => void } | undefined;
    if (result.status === 'pending' && result.queued > 0) indexer?.wake?.();

    return result;
  }
}

export function createKnowledgeReindexService(
  db: TenantScopeAwareDatabase,
  app?: Application
): KnowledgeReindexService {
  return new KnowledgeReindexService(db, app);
}
