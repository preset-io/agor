import {
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
    _app?: Application
  ) {
    this.settings = new KnowledgeSemanticSettingsRepository(db);
  }

  async find(_params?: KnowledgeIndexingParams): Promise<KnowledgeIndexingStatus> {
    const semantic = await this.settings.find();
    const counts = Object.fromEntries(STATUSES.map((status) => [status, 0])) as Record<
      KnowledgeEmbeddingStatus,
      number
    >;

    const currentUnitFilter = sql`${kbDocumentUnits.version_id} IN (
      SELECT d.current_version_id
      FROM kb_documents AS d
      JOIN kb_namespaces AS n ON n.namespace_id = d.namespace_id
      WHERE d.current_version_id IS NOT NULL
        AND d.archived = false
        AND n.archived = false
    )`;
    const rows = await select(this.db, {
      status: kbDocumentUnits.embedding_status,
      count: sql<number>`count(*)`,
      last_updated_at: sql<Date | null>`max(${kbDocumentUnits.updated_at})`,
    })
      .from(kbDocumentUnits)
      .where(currentUnitFilter)
      .groupBy(kbDocumentUnits.embedding_status)
      .all();
    let lastIndexedAt: Date | null = null;
    for (const row of rows as Array<{
      status: KnowledgeEmbeddingStatus;
      count: number | string;
      last_updated_at: Date | string | null;
    }>) {
      counts[row.status] = Number(row.count) || 0;
      if (row.status === 'ready' && row.last_updated_at) {
        lastIndexedAt = new Date(row.last_updated_at);
      }
    }
    const latestError = await select(this.db, { error: kbDocumentUnits.embedding_error })
      .from(kbDocumentUnits)
      .where(
        sql`${currentUnitFilter} AND ${kbDocumentUnits.embedding_status} = 'error' AND ${kbDocumentUnits.embedding_error} IS NOT NULL`
      )
      .orderBy(sql`${kbDocumentUnits.updated_at} DESC NULLS LAST`)
      .limit(1)
      .one();
    const durableLastError = latestError?.error ?? null;

    const pgvector = await getKnowledgePgvectorCapability(this.db);
    const semanticEnabled = semantic.enabled;
    const embeddingConfigUsable = isUsableOpenAIEmbeddingConfig(
      semantic,
      semantic.api_key_configured
    );
    const configured = isPostgresDatabase(this.db) && pgvector.available && embeddingConfigUsable;

    const lastError = semanticEnabled
      ? ((configured ? durableLastError : null) ?? (!pgvector.available ? pgvector.reason : null))
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
      queue_depth: counts.pending + counts.stale + counts.error,
      last_indexed_at: lastIndexedAt,
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
