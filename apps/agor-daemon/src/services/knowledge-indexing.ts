import {
  getCurrentTenantId,
  isPostgresDatabase,
  KnowledgeSemanticSettingsRepository,
  kbDocumentUnits,
  select,
  sql,
  type TenantScopeAwareDatabase,
} from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import type {
  AuthenticatedParams,
  KnowledgeEmbeddingStatus,
  KnowledgeIndexingStatus,
  Params,
} from '@agor/core/types';
import { isUsableOpenAIEmbeddingConfig } from '../knowledge/embeddings.js';
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
  private settings: KnowledgeSemanticSettingsRepository;

  constructor(
    private db: TenantScopeAwareDatabase,
    private app?: Application
  ) {
    this.settings = new KnowledgeSemanticSettingsRepository(db);
  }

  async find(_params?: KnowledgeIndexingParams): Promise<KnowledgeIndexingStatus> {
    const semantic = await this.settings.find();
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
    const semanticEnabled = semantic.enabled;
    const embeddingConfigUsable = isUsableOpenAIEmbeddingConfig(
      semantic,
      semantic.api_key_configured
    );
    const configured = isPostgresDatabase(this.db) && pgvector.available && embeddingConfigUsable;

    const indexer = (this.app as unknown as { get?: (key: string) => unknown } | undefined)?.get?.(
      'knowledgeEmbeddingIndexer'
    ) as
      | {
          getLastIndexedAt?: (tenantId?: string) => Date | null;
          getLastError?: (tenantId?: string) => string | null;
        }
      | undefined;
    const tenantId = String(getCurrentTenantId() ?? 'default');
    const lastError = semanticEnabled
      ? ((configured ? indexer?.getLastError?.(tenantId) : null) ??
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
      provider: semantic.provider,
      model: semantic.model,
      dimensions: semantic.dimensions,
      chunks: counts,
      queue_depth: counts.pending + counts.stale,
      last_indexed_at: indexer?.getLastIndexedAt?.(tenantId) ?? null,
      last_error: lastError,
    };
  }
}

export function createKnowledgeIndexingStatusService(
  db: TenantScopeAwareDatabase,
  app?: Application
): KnowledgeIndexingStatusService {
  return new KnowledgeIndexingStatusService(db, app);
}
