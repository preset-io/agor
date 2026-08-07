import type { DistributedWorkIdentity } from '@agor/core/coordination';
import {
  assertTenantWritable,
  generateId,
  insert,
  type KnowledgeEmbeddingClaim,
  KnowledgeEmbeddingWorkRepository,
  KnowledgeSemanticSettingsRepository,
  kbEmbeddingSpaces,
  runWithTenantDatabaseScope,
  select,
  shortId,
  sql,
  type TenantScopeAwareDatabase,
  type TenantScopedDatabase,
} from '@agor/core/db';
import type { KnowledgeDocumentUnitID, KnowledgeSemanticPolicy, TenantID } from '@agor/core/types';
import {
  DEFAULT_OPENAI_EMBEDDING_DIMENSIONS,
  type EmbeddingProvider,
  EmbeddingProviderHttpError,
  embeddingToPgvector,
  SUPPORTED_OPENAI_EMBEDDING_MODELS,
  sha256Text,
} from '../knowledge/embeddings.js';
import type { ensureKnowledgePgvectorStorage } from '../knowledge/pgvector.js';
import {
  isKnowledgeEmbeddingMaterializationSnapshotCurrent,
  KnowledgeEmbeddingReuseService,
} from './knowledge-embedding-reuse.js';

export class KnowledgeEmbeddingPreClaimError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown
  ) {
    super(message);
    this.name = 'KnowledgeEmbeddingPreClaimError';
  }
}

interface PreparedEmbeddingBatch {
  semantic: KnowledgeSemanticPolicy;
  apiKey: string;
  embeddingSpaceId: string;
  claimToken: string;
  claims: KnowledgeEmbeddingClaim[];
  providerClaims: KnowledgeEmbeddingClaim[];
  reused: number;
}

export interface KnowledgeEmbeddingBatchProcessorOptions {
  perTenantBatchSize: number;
  claimLeaseMs: number;
  providerTimeoutMs: number;
  retryBaseMs: number;
  retryMaxMs: number;
  workIdentity: DistributedWorkIdentity;
  provider: EmbeddingProvider;
  generateClaimToken: () => string;
  ensureStorage: typeof ensureKnowledgePgvectorStorage;
  isShutdownRequested: () => boolean;
}

export function hasExactEmbeddingResultIds(
  expectedIds: readonly string[],
  results: readonly { id: string }[]
): boolean {
  const expected = new Set(expectedIds);
  const actual = new Set(results.map((result) => result.id));
  return (
    expected.size === expectedIds.length &&
    actual.size === results.length &&
    actual.size === expected.size &&
    [...expected].every((id) => actual.has(id))
  );
}

export function hasExpectedEmbeddingShape(
  results: readonly { dimensions: number; embedding: readonly number[] }[],
  expectedDimensions: number
): boolean {
  return (
    Number.isInteger(expectedDimensions) &&
    expectedDimensions > 0 &&
    results.every(
      (result) =>
        result.dimensions === expectedDimensions &&
        result.embedding.length === expectedDimensions &&
        result.embedding.every(Number.isFinite)
    )
  );
}

/**
 * Tenant-scoped claim/materialize/provider/commit state machine.
 *
 * The per-daemon scanner owns discovery only. This processor deliberately re-enters a
 * trusted tenant scope for each short transaction and never retains a scoped
 * database across the external provider call.
 */
export class KnowledgeEmbeddingBatchProcessor {
  private activeProviderController: AbortController | null = null;
  private pgvectorStorageReady = false;

  constructor(
    private readonly db: TenantScopeAwareDatabase,
    private readonly options: KnowledgeEmbeddingBatchProcessorOptions
  ) {}

  abortProviderWait(reason: Error): void {
    this.activeProviderController?.abort(reason);
  }

  private async withTenantDatabase<T>(
    tenantId: TenantID | string,
    work: (db: TenantScopedDatabase) => Promise<T>
  ): Promise<T> {
    return runWithTenantDatabaseScope(this.db, tenantId, async (scopedDb) => {
      await assertTenantWritable(scopedDb, tenantId);
      return work(scopedDb);
    });
  }

  private async ensureEmbeddingSpace(
    db: TenantScopedDatabase,
    params: { provider: string; model: string; dimensions: number }
  ): Promise<string> {
    const where = sql`${kbEmbeddingSpaces.provider} = ${params.provider} AND ${kbEmbeddingSpaces.model} = ${params.model} AND ${kbEmbeddingSpaces.dimensions} = ${params.dimensions} AND ${kbEmbeddingSpaces.storage_type} = 'vector' AND ${kbEmbeddingSpaces.distance} = 'cosine'`;
    const existing = await select(db).from(kbEmbeddingSpaces).where(where).limit(1).one();
    if (existing?.embedding_space_id) return existing.embedding_space_id as string;

    await insert(db, kbEmbeddingSpaces)
      .values({
        embedding_space_id: generateId(),
        provider: params.provider,
        model: params.model,
        dimensions: params.dimensions,
        storage_type: 'vector',
        distance: 'cosine',
        active: true,
        metadata: null,
        created_at: new Date(),
        updated_at: new Date(),
      })
      .onConflictDoNothing()
      .run();
    const created = await select(db).from(kbEmbeddingSpaces).where(where).limit(1).one();
    if (!created?.embedding_space_id) {
      throw new Error('Failed to materialize Knowledge embedding space');
    }
    return created.embedding_space_id as string;
  }

  private isProviderPolicyRunnable(
    semantic: KnowledgeSemanticPolicy,
    apiKeyConfigured: boolean
  ): boolean {
    if (!semantic.enabled || semantic.indexing.paused || !apiKeyConfigured) return false;
    if (semantic.provider !== 'openai') return false;
    if (!SUPPORTED_OPENAI_EMBEDDING_MODELS.has(semantic.model)) {
      throw new Error(`Unsupported OpenAI embedding model: ${semantic.model}`);
    }
    if (semantic.dimensions !== DEFAULT_OPENAI_EMBEDDING_DIMENSIONS) {
      throw new Error(
        'Only 1536-dimensional OpenAI embeddings are supported by the V1 vector table'
      );
    }
    return true;
  }

  private async ensureStorageForRunnablePolicy(tenantId: TenantID | string): Promise<boolean> {
    if (this.pgvectorStorageReady) return true;

    // This is only a routing preflight. The claim transaction locks and checks
    // the aggregate again below, so a concurrent settings change cannot make
    // stale policy own work. Keeping storage DDL in its own tenant transaction
    // avoids holding the aggregate lock while storage is inspected/materialized.
    try {
      const runnable = await this.withTenantDatabase(tenantId, async (scopedDb) => {
        const settings = await new KnowledgeSemanticSettingsRepository(scopedDb).find();
        return this.isProviderPolicyRunnable(settings, settings.api_key_configured);
      });
      if (!runnable) return false;

      const capability = await this.withTenantDatabase(tenantId, (scopedDb) =>
        this.options.ensureStorage(scopedDb)
      );
      if (!capability.available) {
        throw new Error(capability.reason ?? 'Knowledge pgvector storage is unavailable');
      }
    } catch (error) {
      throw new KnowledgeEmbeddingPreClaimError(
        error instanceof Error ? error.message : String(error),
        error
      );
    }
    this.pgvectorStorageReady = true;
    return true;
  }

  private async prepareBatch(
    tenantId: TenantID | string,
    unitIds: KnowledgeDocumentUnitID[]
  ): Promise<PreparedEmbeddingBatch | null> {
    if (unitIds.length === 0 || this.options.isShutdownRequested()) return null;
    if (!(await this.ensureStorageForRunnablePolicy(tenantId))) return null;
    return this.withTenantDatabase(tenantId, async (scopedDb) => {
      const settings = new KnowledgeSemanticSettingsRepository(scopedDb);
      const semantic = await settings.lockAggregateForUpdate(scopedDb);
      const apiKey = await settings.getApiKey();
      if (!apiKey || !this.isProviderPolicyRunnable(semantic, true)) return null;
      const batchSize = Math.min(
        Math.max(semantic.indexing.batch_size, 1),
        this.options.perTenantBatchSize,
        unitIds.length
      );
      const embeddingSpaceId = await this.ensureEmbeddingSpace(scopedDb, semantic);
      const claimToken = this.options.generateClaimToken();
      const claims = await new KnowledgeEmbeddingWorkRepository(scopedDb).claimCurrentUnits({
        unitIds,
        claimToken,
        leaseMs: this.options.claimLeaseMs,
        identity: this.options.workIdentity,
        limit: batchSize,
      });
      if (claims.length === 0) return null;

      const reuseService = new KnowledgeEmbeddingReuseService(scopedDb);
      const reusedRows = await reuseService.reuseExistingEmbeddings({
        embeddingSpaceId,
        model: semantic.model,
        dimensions: semantic.dimensions,
        limit: claims.length,
        claimToken,
      });
      await reuseService.recordEmbeddingReuseIntoNext({
        rows: reusedRows,
        embeddingSpaceId,
        provider: semantic.provider,
        model: semantic.model,
        dimensions: semantic.dimensions,
      });
      const reusedIds = new Set(reusedRows.map((row) => row.unit_id));
      return {
        semantic,
        apiKey,
        embeddingSpaceId,
        claimToken,
        claims,
        providerClaims: claims.filter((claim) => !reusedIds.has(claim.unit_id)),
        reused: reusedRows.length,
      };
    });
  }

  private async recordProviderFailure(
    tenantId: TenantID | string,
    prepared: PreparedEmbeddingBatch,
    error: unknown
  ): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    const httpError = error instanceof EmbeddingProviderHttpError ? error : null;
    await this.withTenantDatabase(tenantId, (scopedDb) =>
      new KnowledgeEmbeddingWorkRepository(scopedDb).failClaims({
        claimToken: prepared.claimToken,
        claims: prepared.providerClaims,
        error: message,
        baseRetryMs: this.options.retryBaseMs,
        maxRetryMs: this.options.retryMaxMs,
        retryable: httpError?.retryable ?? true,
        retryAfterMs: httpError?.retryAfterMs ?? null,
        retryAfterAt: httpError?.retryAfterAt ?? null,
      })
    );
  }

  private async releaseProviderClaims(
    tenantId: TenantID | string,
    prepared: PreparedEmbeddingBatch
  ): Promise<number> {
    const released = await this.withTenantDatabase(tenantId, (scopedDb) =>
      new KnowledgeEmbeddingWorkRepository(scopedDb).releaseClaims({
        claimToken: prepared.claimToken,
        claims: prepared.providerClaims,
      })
    );
    return released.length;
  }

  private async admitProviderCall(
    tenantId: TenantID | string,
    prepared: PreparedEmbeddingBatch
  ): Promise<boolean> {
    return this.withTenantDatabase(tenantId, async (scopedDb) => {
      const settings = new KnowledgeSemanticSettingsRepository(scopedDb);
      const current = await settings.lockAggregateForUpdate(scopedDb);
      const currentApiKey = await settings.getApiKey();
      const work = new KnowledgeEmbeddingWorkRepository(scopedDb);
      if (
        !currentApiKey ||
        !this.isProviderPolicyRunnable(current, true) ||
        !isKnowledgeEmbeddingMaterializationSnapshotCurrent(
          prepared.semantic,
          current,
          prepared.apiKey,
          currentApiKey
        )
      ) {
        await work.releaseClaims({
          claimToken: prepared.claimToken,
          claims: prepared.providerClaims,
        });
        return false;
      }

      const admitted = await work.renewClaimsForProviderCall({
        claimToken: prepared.claimToken,
        claims: prepared.providerClaims,
        leaseMs: this.options.claimLeaseMs,
      });
      const exactAdmission =
        admitted.length === prepared.providerClaims.length &&
        prepared.providerClaims.every((claim) => admitted.includes(claim.unit_id));
      if (!exactAdmission) {
        await work.releaseClaims({
          claimToken: prepared.claimToken,
          claims: prepared.providerClaims,
        });
      }
      return exactAdmission;
    });
  }

  private async commitProviderResults(
    tenantId: TenantID | string,
    prepared: PreparedEmbeddingBatch,
    results: Awaited<ReturnType<EmbeddingProvider['embed']>>
  ): Promise<number> {
    const claimById = new Map(prepared.providerClaims.map((claim) => [claim.unit_id, claim]));
    if (!hasExactEmbeddingResultIds([...claimById.keys()], results)) {
      throw new Error('Embedding provider returned an incomplete or mismatched batch');
    }
    if (!hasExpectedEmbeddingShape(results, prepared.semantic.dimensions)) {
      throw new Error('Embedding provider returned vectors with invalid dimensions or values');
    }
    return this.withTenantDatabase(tenantId, async (scopedDb) => {
      const settings = new KnowledgeSemanticSettingsRepository(scopedDb);
      const current = await settings.lockAggregateForUpdate(scopedDb);
      const currentApiKey = await settings.getApiKey();
      if (
        !isKnowledgeEmbeddingMaterializationSnapshotCurrent(
          prepared.semantic,
          current,
          prepared.apiKey,
          currentApiKey
        )
      ) {
        return 0;
      }
      const completed = await new KnowledgeEmbeddingWorkRepository(scopedDb).completeClaims({
        claimToken: prepared.claimToken,
        embeddingSpaceId: prepared.embeddingSpaceId,
        model: prepared.semantic.model,
        dimensions: prepared.semantic.dimensions,
        completions: results.map((result) => {
          const claim = claimById.get(result.id as KnowledgeDocumentUnitID)!;
          return {
            unitId: claim.unit_id,
            claimGeneration: claim.claim_generation,
            contentText: claim.content_text,
            contentMd5: claim.content_md5,
            contentSha256: sha256Text(claim.content_text),
            embedding: embeddingToPgvector(result.embedding),
            tokenCount: result.tokenCount ?? null,
          };
        }),
      });
      return completed.length;
    });
  }

  async processTenantBatch(
    tenantId: TenantID | string,
    unitIds: KnowledgeDocumentUnitID[]
  ): Promise<{ claimed: number; indexed: number }> {
    const prepared = await this.prepareBatch(tenantId, unitIds);
    if (!prepared) return { claimed: 0, indexed: 0 };
    if (prepared.providerClaims.length === 0) {
      return { claimed: prepared.claims.length, indexed: prepared.reused };
    }
    if (this.options.isShutdownRequested()) {
      await this.releaseProviderClaims(tenantId, prepared);
      return { claimed: prepared.claims.length, indexed: prepared.reused };
    }

    if (!(await this.admitProviderCall(tenantId, prepared))) {
      return { claimed: prepared.claims.length, indexed: prepared.reused };
    }
    // JavaScript cannot interleave another turn between this check and the
    // synchronous provider.embed invocation below. A stop observed here is a
    // proven no-call path and may safely relinquish the claim.
    if (this.options.isShutdownRequested()) {
      await this.releaseProviderClaims(tenantId, prepared);
      return { claimed: prepared.claims.length, indexed: prepared.reused };
    }

    const chunksByDocument = new Map<string, number>();
    let totalChars = 0;
    for (const claim of prepared.providerClaims) {
      chunksByDocument.set(claim.document_id, (chunksByDocument.get(claim.document_id) ?? 0) + 1);
      totalChars += claim.content_text.length;
    }
    const docSummary = [...chunksByDocument.entries()]
      .slice(0, 5)
      .map(([documentId, count]) => `${shortId(documentId)}=${count}`)
      .join(', ');
    console.info(
      `[distributed-work.knowledge-index] event=provider_call tenant_id=${JSON.stringify(tenantId)} claim_token=${JSON.stringify(shortId(prepared.claimToken))} chunks=${prepared.providerClaims.length} documents=${chunksByDocument.size} document_chunks=${JSON.stringify(docSummary)} model=${JSON.stringify(prepared.semantic.model)} dimensions=${prepared.semantic.dimensions} chars=${totalChars}`
    );

    const controller = new AbortController();
    this.activeProviderController = controller;
    const timeout = setTimeout(
      () => controller.abort(new Error('Knowledge embedding provider request timed out')),
      this.options.providerTimeoutMs
    );
    timeout.unref?.();
    try {
      const results = await this.options.provider.embed(
        prepared.providerClaims.map((claim) => ({
          id: claim.unit_id,
          text: claim.content_text,
          inputType: 'document',
        })),
        {
          apiKey: prepared.apiKey,
          model: prepared.semantic.model,
          dimensions: prepared.semantic.dimensions,
          signal: controller.signal,
        }
      );
      const committed = await this.commitProviderResults(tenantId, prepared, results);
      if (committed < prepared.providerClaims.length) {
        console.info(
          `[distributed-work.knowledge-index] event=claim_lost tenant_id=${JSON.stringify(tenantId)} claim_token=${JSON.stringify(shortId(prepared.claimToken))} expected=${prepared.providerClaims.length} committed=${committed}`
        );
      }
      return { claimed: prepared.claims.length, indexed: prepared.reused + committed };
    } catch (error) {
      if (!this.options.isShutdownRequested()) {
        await this.recordProviderFailure(tenantId, prepared, error);
      }
      if (this.options.isShutdownRequested()) {
        return { claimed: prepared.claims.length, indexed: prepared.reused };
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      if (this.activeProviderController === controller) this.activeProviderController = null;
    }
  }
}
