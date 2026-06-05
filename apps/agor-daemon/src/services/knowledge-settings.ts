import { type AgorKnowledgeSettings, loadConfig, saveConfig } from '@agor/core/config';
import {
  AppVariableRepository,
  type Database,
  executeRaw,
  isPostgresDatabase,
  kbDocumentUnits,
  sql,
  update,
} from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import { BadRequest } from '@agor/core/feathers';
import type {
  AuthenticatedParams,
  KnowledgeEmbeddingProvider,
  KnowledgeEmbeddingStatus,
  KnowledgeSemanticSettingsPublic,
  Params,
  User,
  UserID,
} from '@agor/core/types';
import {
  DEFAULT_KNOWLEDGE_CHUNKING,
  DEFAULT_KNOWLEDGE_INDEXING,
  DEFAULT_OPENAI_EMBEDDING_DIMENSIONS,
  DEFAULT_OPENAI_EMBEDDING_MODEL,
  isUsableOpenAIEmbeddingConfig,
  KNOWLEDGE_EMBEDDINGS_API_KEY,
  KNOWLEDGE_EMBEDDINGS_NAMESPACE,
  normalizeKnowledgeEmbeddingApiKey,
  SUPPORTED_OPENAI_EMBEDDING_MODELS,
} from '../knowledge/embeddings.js';
import {
  ensureKnowledgePgvectorStorage,
  getKnowledgePgvectorCapability,
} from '../knowledge/pgvector.js';
import { rebuildCurrentKnowledgeUnits } from '../knowledge/units.js';

const DEFAULT_PROVIDER: KnowledgeEmbeddingProvider = 'openai';

type KnowledgeSemanticSearchSettings = NonNullable<AgorKnowledgeSettings['semantic_search']>;
type KnowledgeChunkingSettings = NonNullable<KnowledgeSemanticSearchSettings['chunking']>;

export interface KnowledgeSettingsPatch {
  enabled?: boolean;
  provider?: KnowledgeEmbeddingProvider;
  model?: string | null;
  dimensions?: number | null;
  api_key?: string | null;
  chunking?: KnowledgeSemanticSearchSettings['chunking'];
  indexing?: KnowledgeSemanticSearchSettings['indexing'];
}

export type KnowledgeSettingsParams = Params & AuthenticatedParams;

export class KnowledgeSettingsService {
  private variables: AppVariableRepository;

  constructor(
    private db: Database,
    private app?: Application
  ) {
    this.variables = new AppVariableRepository(db);
  }

  private async publicSettings(): Promise<KnowledgeSemanticSettingsPublic> {
    const config = await loadConfig();
    const settings = config.knowledge?.semantic_search ?? {};
    const apiKey = await this.variables.find(
      KNOWLEDGE_EMBEDDINGS_NAMESPACE,
      KNOWLEDGE_EMBEDDINGS_API_KEY
    );
    return {
      enabled: settings.enabled === true,
      provider: settings.provider ?? DEFAULT_PROVIDER,
      model: settings.model ?? DEFAULT_OPENAI_EMBEDDING_MODEL,
      dimensions: settings.dimensions ?? DEFAULT_OPENAI_EMBEDDING_DIMENSIONS,
      api_key_configured: Boolean(apiKey?.value_encrypted),
      chunking: { ...DEFAULT_KNOWLEDGE_CHUNKING, ...(settings.chunking ?? {}) },
      indexing: { ...DEFAULT_KNOWLEDGE_INDEXING, ...(settings.indexing ?? {}) },
    };
  }

  private validateChunking(chunking?: KnowledgeChunkingSettings): void {
    if (!chunking) return;
    const entries = [
      ['target_tokens', chunking.target_tokens],
      ['max_tokens', chunking.max_tokens],
      ['overlap_tokens', chunking.overlap_tokens],
      ['min_tokens', chunking.min_tokens],
    ] as const;
    for (const [name, value] of entries) {
      if (value === undefined) continue;
      if (!Number.isInteger(value) || value < 0) {
        throw new BadRequest(`Knowledge chunking ${name} must be a non-negative integer`);
      }
      if (value > 8000) {
        throw new BadRequest(`Knowledge chunking ${name} must be 8000 or less`);
      }
    }

    const merged = { ...DEFAULT_KNOWLEDGE_CHUNKING, ...chunking };
    if (merged.min_tokens <= 0) {
      throw new BadRequest('Knowledge chunking min_tokens must be greater than 0');
    }
    if (merged.target_tokens <= 0) {
      throw new BadRequest('Knowledge chunking target_tokens must be greater than 0');
    }
    if (merged.max_tokens < merged.min_tokens) {
      throw new BadRequest(
        'Knowledge chunking max_tokens must be greater than or equal to min_tokens'
      );
    }
    if (merged.target_tokens > merged.max_tokens) {
      throw new BadRequest(
        'Knowledge chunking target_tokens must be less than or equal to max_tokens'
      );
    }
    if (merged.overlap_tokens >= merged.max_tokens) {
      throw new BadRequest('Knowledge chunking overlap_tokens must be less than max_tokens');
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
    const config = await loadConfig();
    const current = config.knowledge?.semantic_search ?? {};
    const next = {
      ...current,
      ...(data.enabled !== undefined ? { enabled: data.enabled } : {}),
      ...(data.provider !== undefined ? { provider: data.provider } : {}),
      ...(data.model !== undefined ? { model: data.model ?? undefined } : {}),
      ...(data.dimensions !== undefined ? { dimensions: data.dimensions ?? undefined } : {}),
      ...(data.chunking !== undefined ? { chunking: data.chunking } : {}),
      ...(data.indexing !== undefined ? { indexing: data.indexing } : {}),
    };

    if ((next.provider ?? DEFAULT_PROVIDER) !== 'openai') {
      throw new BadRequest('Knowledge semantic search currently supports only OpenAI embeddings');
    }
    this.validateChunking(next.chunking);
    if (
      next.dimensions !== undefined &&
      (!Number.isInteger(next.dimensions) || next.dimensions <= 0)
    ) {
      throw new BadRequest('Knowledge embedding dimensions must be a positive integer');
    }
    if ((next.provider ?? DEFAULT_PROVIDER) === 'openai') {
      const model = next.model ?? DEFAULT_OPENAI_EMBEDDING_MODEL;
      if (!SUPPORTED_OPENAI_EMBEDDING_MODELS.has(model)) {
        throw new BadRequest(`Unsupported OpenAI embedding model: ${model}`);
      }
      if (
        (next.dimensions ?? DEFAULT_OPENAI_EMBEDDING_DIMENSIONS) !==
        DEFAULT_OPENAI_EMBEDDING_DIMENSIONS
      ) {
        throw new BadRequest(
          'Knowledge semantic search currently supports 1536-dimensional OpenAI embeddings'
        );
      }
    }

    const previousIdentity = {
      enabled: current.enabled === true,
      provider: current.provider ?? DEFAULT_PROVIDER,
      model: current.model ?? DEFAULT_OPENAI_EMBEDDING_MODEL,
      dimensions: current.dimensions ?? DEFAULT_OPENAI_EMBEDDING_DIMENSIONS,
    };
    const nextIdentity = {
      enabled: next.enabled === true,
      provider: next.provider ?? DEFAULT_PROVIDER,
      model: next.model ?? DEFAULT_OPENAI_EMBEDDING_MODEL,
      dimensions: next.dimensions ?? DEFAULT_OPENAI_EMBEDDING_DIMENSIONS,
    };
    const identityChanged =
      previousIdentity.enabled !== nextIdentity.enabled ||
      previousIdentity.provider !== nextIdentity.provider ||
      previousIdentity.model !== nextIdentity.model ||
      previousIdentity.dimensions !== nextIdentity.dimensions ||
      data.api_key !== undefined;
    const chunkingChanged = data.chunking !== undefined;

    config.knowledge = { ...(config.knowledge ?? {}), semantic_search: next };
    await saveConfig(config);

    if (data.api_key !== undefined) {
      const user = params?.user as User | undefined;
      await this.variables.setEncrypted(
        KNOWLEDGE_EMBEDDINGS_NAMESPACE,
        KNOWLEDGE_EMBEDDINGS_API_KEY,
        normalizeKnowledgeEmbeddingApiKey(data.api_key),
        (user?.user_id as UserID | undefined) ?? null
      );
    }

    if (identityChanged || chunkingChanged) {
      const apiKey = await this.variables.find(
        KNOWLEDGE_EMBEDDINGS_NAMESPACE,
        KNOWLEDGE_EMBEDDINGS_API_KEY
      );
      const configured =
        isPostgresDatabase(this.db) &&
        isUsableOpenAIEmbeddingConfig(next, Boolean(apiKey?.value_encrypted)) &&
        (await ensureKnowledgePgvectorStorage(this.db)).available;
      const queued = chunkingChanged
        ? await rebuildCurrentKnowledgeUnits(this.db, config, { embeddingConfigured: configured })
        : await this.markCurrentUnitsForEmbedding(configured ? 'pending' : 'not_configured');
      if (queued > 0 && configured) this.wakeIndexer();
    }

    return this.publicSettings();
  }

  async create(data: KnowledgeSettingsPatch, params?: KnowledgeSettingsParams) {
    return this.patch(null, data, params);
  }
}

export function createKnowledgeSettingsService(
  db: Database,
  app?: Application
): KnowledgeSettingsService {
  return new KnowledgeSettingsService(db, app);
}
