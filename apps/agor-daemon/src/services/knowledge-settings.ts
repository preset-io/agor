import {
  executeRaw,
  isPostgresDatabase,
  KnowledgeSemanticSettingsRepository,
  kbDocumentUnits,
  sql,
  type TenantScopeAwareDatabase,
  update,
} from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import { BadRequest } from '@agor/core/feathers';
import type {
  AuthenticatedParams,
  KnowledgeEmbeddingStatus,
  KnowledgeSemanticPolicy,
  KnowledgeSemanticSettingsPatch,
  KnowledgeSemanticSettingsPublic,
  Params,
  User,
  UserID,
} from '@agor/core/types';
import {
  DEFAULT_OPENAI_EMBEDDING_DIMENSIONS,
  isUsableOpenAIEmbeddingConfig,
  SUPPORTED_OPENAI_EMBEDDING_MODELS,
} from '../knowledge/embeddings.js';
import {
  ensureKnowledgePgvectorStorage,
  getKnowledgePgvectorCapability,
} from '../knowledge/pgvector.js';
import { rebuildCurrentKnowledgeUnits } from '../knowledge/units.js';

export type KnowledgeSettingsPatch = KnowledgeSemanticSettingsPatch;

export type KnowledgeSettingsParams = Params & AuthenticatedParams;

export class KnowledgeSettingsService {
  private settings: KnowledgeSemanticSettingsRepository;

  constructor(
    private db: TenantScopeAwareDatabase,
    private app?: Application
  ) {
    this.settings = new KnowledgeSemanticSettingsRepository(db);
  }

  private async publicSettings(): Promise<KnowledgeSemanticSettingsPublic> {
    return this.settings.find();
  }

  private validateChunking(chunking: KnowledgeSemanticPolicy['chunking']): void {
    const entries = [
      ['target_tokens', chunking.target_tokens],
      ['max_tokens', chunking.max_tokens],
      ['overlap_tokens', chunking.overlap_tokens],
      ['min_tokens', chunking.min_tokens],
    ] as const;
    for (const [name, value] of entries) {
      if (!Number.isInteger(value) || value < 0) {
        throw new BadRequest(`Knowledge chunking ${name} must be a non-negative integer`);
      }
      if (value > 8000) {
        throw new BadRequest(`Knowledge chunking ${name} must be 8000 or less`);
      }
    }

    if (chunking.min_tokens <= 0) {
      throw new BadRequest('Knowledge chunking min_tokens must be greater than 0');
    }
    if (chunking.target_tokens <= 0) {
      throw new BadRequest('Knowledge chunking target_tokens must be greater than 0');
    }
    if (chunking.max_tokens < chunking.min_tokens) {
      throw new BadRequest(
        'Knowledge chunking max_tokens must be greater than or equal to min_tokens'
      );
    }
    if (chunking.target_tokens > chunking.max_tokens) {
      throw new BadRequest(
        'Knowledge chunking target_tokens must be less than or equal to max_tokens'
      );
    }
    if (chunking.overlap_tokens >= chunking.max_tokens) {
      throw new BadRequest('Knowledge chunking overlap_tokens must be less than max_tokens');
    }
  }

  private validateIndexing(indexing: KnowledgeSemanticPolicy['indexing']): void {
    if (typeof indexing.paused !== 'boolean') {
      throw new BadRequest('Knowledge indexing paused must be a boolean');
    }
    if (
      !Number.isInteger(indexing.batch_size) ||
      indexing.batch_size < 1 ||
      indexing.batch_size > 128
    ) {
      throw new BadRequest('Knowledge indexing batch_size must be an integer between 1 and 128');
    }
    if (
      !Number.isInteger(indexing.concurrency) ||
      indexing.concurrency < 1 ||
      indexing.concurrency > 32
    ) {
      throw new BadRequest('Knowledge indexing concurrency must be an integer between 1 and 32');
    }
  }

  private validatePolicy(policy: KnowledgeSemanticPolicy): void {
    if (policy.provider !== 'openai') {
      throw new BadRequest('Knowledge semantic search currently supports only OpenAI embeddings');
    }
    this.validateChunking(policy.chunking);
    this.validateIndexing(policy.indexing);
    if (!Number.isInteger(policy.dimensions) || policy.dimensions <= 0) {
      throw new BadRequest('Knowledge embedding dimensions must be a positive integer');
    }
    if (!SUPPORTED_OPENAI_EMBEDDING_MODELS.has(policy.model)) {
      throw new BadRequest(`Unsupported OpenAI embedding model: ${policy.model}`);
    }
    if (policy.dimensions !== DEFAULT_OPENAI_EMBEDDING_DIMENSIONS) {
      throw new BadRequest(
        'Knowledge semantic search currently supports 1536-dimensional OpenAI embeddings'
      );
    }
  }

  private validatePatchShape(data: KnowledgeSettingsPatch): void {
    const allowedFields = new Set([
      'enabled',
      'provider',
      'model',
      'dimensions',
      'api_key',
      'chunking',
      'indexing',
    ]);
    const unknownField = Object.keys(data).find((field) => !allowedFields.has(field));
    if (unknownField) {
      throw new BadRequest(`Unknown Knowledge semantic-search setting: ${unknownField}`);
    }
    if (data.enabled !== undefined && typeof data.enabled !== 'boolean') {
      throw new BadRequest('Knowledge semantic search enabled must be a boolean');
    }
    if (
      data.provider !== undefined &&
      data.provider !== null &&
      typeof data.provider !== 'string'
    ) {
      throw new BadRequest('Knowledge embedding provider must be a string');
    }
    if (data.model !== undefined && data.model !== null && typeof data.model !== 'string') {
      throw new BadRequest('Knowledge embedding model must be a string');
    }
    if (
      data.dimensions !== undefined &&
      data.dimensions !== null &&
      typeof data.dimensions !== 'number'
    ) {
      throw new BadRequest('Knowledge embedding dimensions must be a number');
    }
    if (data.api_key !== undefined && data.api_key !== null && typeof data.api_key !== 'string') {
      throw new BadRequest('Knowledge embedding API key must be a string or null');
    }
    for (const [section, value] of [
      ['chunking', data.chunking],
      ['indexing', data.indexing],
    ] as const) {
      if (
        value !== undefined &&
        value !== null &&
        (!value || typeof value !== 'object' || Array.isArray(value))
      ) {
        throw new BadRequest(`Knowledge ${section} settings must be an object or null`);
      }
      const allowedSectionFields =
        section === 'chunking'
          ? new Set(['target_tokens', 'max_tokens', 'overlap_tokens', 'min_tokens'])
          : new Set(['paused', 'batch_size', 'concurrency']);
      const unknownSectionField =
        value && typeof value === 'object' && !Array.isArray(value)
          ? Object.keys(value).find((field) => !allowedSectionFields.has(field))
          : undefined;
      if (unknownSectionField) {
        throw new BadRequest(`Unknown Knowledge ${section} setting: ${unknownSectionField}`);
      }
    }
  }

  private async markCurrentUnitsForEmbedding(status: KnowledgeEmbeddingStatus): Promise<number> {
    const rows = await update(this.db, kbDocumentUnits)
      .set({
        embedding_status: status,
        embedding_model: null,
        embedding_dimensions: null,
        embedding_error: null,
        updated_at: new Date(),
      })
      .where(
        sql`${kbDocumentUnits.version_id} IN (SELECT current_version_id FROM kb_documents WHERE current_version_id IS NOT NULL AND archived = false)`
      )
      .returning({ unit_id: kbDocumentUnits.unit_id })
      .all();

    if (isPostgresDatabase(this.db) && rows.length > 0) {
      const pgvector = await getKnowledgePgvectorCapability(this.db);
      if (pgvector.storageReady) {
        await executeRaw(
          this.db,
          sql`DELETE FROM kb_unit_embeddings WHERE unit_id IN (SELECT unit_id FROM kb_document_units WHERE version_id IN (SELECT current_version_id FROM kb_documents WHERE current_version_id IS NOT NULL AND archived = false))`
        );
      }
    }
    return rows.length;
  }

  private wakeIndexer(): void {
    const indexer = (this.app as unknown as { get?: (key: string) => unknown } | undefined)?.get?.(
      'knowledgeEmbeddingIndexer'
    ) as { wake?: () => void } | undefined;
    indexer?.wake?.();
  }

  async find(_params?: KnowledgeSettingsParams): Promise<KnowledgeSemanticSettingsPublic> {
    return this.publicSettings();
  }

  async patch(
    _id: null,
    data: KnowledgeSettingsPatch,
    params?: KnowledgeSettingsParams
  ): Promise<KnowledgeSemanticSettingsPublic> {
    this.validatePatchShape(data);
    const current = await this.publicSettings();

    const user = params?.user as User | undefined;
    const saved = await this.settings.patch(
      data,
      (user?.user_id as UserID | undefined) ?? null,
      (policy) => this.validatePolicy(policy)
    );
    const identityChanged =
      current.enabled !== saved.enabled ||
      current.provider !== saved.provider ||
      current.model !== saved.model ||
      current.dimensions !== saved.dimensions ||
      data.api_key !== undefined;
    const chunkingChanged = JSON.stringify(current.chunking) !== JSON.stringify(saved.chunking);

    if (identityChanged || chunkingChanged) {
      const configured =
        isPostgresDatabase(this.db) &&
        isUsableOpenAIEmbeddingConfig(saved, saved.api_key_configured) &&
        (await ensureKnowledgePgvectorStorage(this.db)).available;
      const queued = chunkingChanged
        ? await rebuildCurrentKnowledgeUnits(this.db, saved, {
            embeddingConfigured: configured,
          })
        : await this.markCurrentUnitsForEmbedding(configured ? 'pending' : 'not_configured');
      if (queued > 0 && configured) this.wakeIndexer();
    }

    return saved;
  }

  async create(data: KnowledgeSettingsPatch, params?: KnowledgeSettingsParams) {
    return this.patch(null, data, params);
  }
}

export function createKnowledgeSettingsService(
  db: TenantScopeAwareDatabase,
  app?: Application
): KnowledgeSettingsService {
  return new KnowledgeSettingsService(db, app);
}
