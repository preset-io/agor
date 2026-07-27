import {
  executeRaw,
  isPostgresDatabase,
  KnowledgeSemanticSettingsRepository,
  kbDocumentUnits,
  sql,
  type TenantScopeAwareDatabase,
  type TenantScopedDatabase,
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
import { KnowledgeSemanticPolicyValidationError } from '@agor/core/types';
import {
  DEFAULT_OPENAI_EMBEDDING_DIMENSIONS,
  isUsableOpenAIEmbeddingConfig,
  SUPPORTED_OPENAI_EMBEDDING_MODELS,
} from '../knowledge/embeddings.js';
import {
  ensureKnowledgePgvectorStorage,
  getKnowledgePgvectorCapability,
} from '../knowledge/pgvector.js';
import { runKnowledgePolicyTransaction } from '../knowledge/policy-transaction.js';
import { rebuildCurrentKnowledgeUnits } from '../knowledge/units.js';

export type KnowledgeSettingsPatch = KnowledgeSemanticSettingsPatch;

export type KnowledgeSettingsParams = Params & AuthenticatedParams;
type KnowledgeSettingsDatabase = TenantScopeAwareDatabase | TenantScopedDatabase;

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

  private validateProviderCapability(policy: KnowledgeSemanticPolicy): void {
    if (policy.provider !== 'openai') {
      throw new BadRequest('Knowledge semantic search currently supports only OpenAI embeddings');
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
          : new Set(['paused', 'batch_size']);
      const unknownSectionField =
        value && typeof value === 'object' && !Array.isArray(value)
          ? Object.keys(value).find((field) => !allowedSectionFields.has(field))
          : undefined;
      if (unknownSectionField) {
        throw new BadRequest(`Unknown Knowledge ${section} setting: ${unknownSectionField}`);
      }
    }
  }

  private async markCurrentUnitsForEmbedding(
    db: KnowledgeSettingsDatabase,
    status: KnowledgeEmbeddingStatus
  ): Promise<number> {
    const rows = await update(db, kbDocumentUnits)
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

    if (isPostgresDatabase(db) && rows.length > 0) {
      const pgvector = await getKnowledgePgvectorCapability(db);
      if (pgvector.storageReady) {
        await executeRaw(
          db,
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
    const user = params?.user as User | undefined;
    const updatedBy = (user?.user_id as UserID | undefined) ?? null;
    const apply = async (
      db: TenantScopedDatabase
    ): Promise<{ saved: KnowledgeSemanticSettingsPublic; shouldWake: boolean }> => {
      const settings = new KnowledgeSemanticSettingsRepository(db);
      const { previous: current, saved } = await settings.patchInTransaction(
        db,
        data,
        updatedBy,
        (policy) => this.validateProviderCapability(policy)
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
          isPostgresDatabase(db) &&
          isUsableOpenAIEmbeddingConfig(saved, saved.api_key_configured) &&
          (await ensureKnowledgePgvectorStorage(db)).available;
        const queued = chunkingChanged
          ? await rebuildCurrentKnowledgeUnits(db, saved, {
              embeddingConfigured: configured,
            })
          : await this.markCurrentUnitsForEmbedding(db, configured ? 'pending' : 'not_configured');
        return { saved, shouldWake: queued > 0 && configured };
      }

      return { saved, shouldWake: false };
    };

    try {
      const result = await runKnowledgePolicyTransaction(this.db, apply);
      if (result.shouldWake) this.wakeIndexer();
      return result.saved;
    } catch (error) {
      if (error instanceof KnowledgeSemanticPolicyValidationError) {
        throw new BadRequest(error.message);
      }
      throw error;
    }
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
