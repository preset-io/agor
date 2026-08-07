import {
  boundedBackoffDelay,
  type DistributedWorkIdentity,
  initialWorkOffset,
  jitterDelay,
} from '@agor/core/coordination';
import {
  enqueueAfterTenantDatabaseCommit,
  generateId,
  getCurrentTenantId,
  isPostgresDatabase,
  type KnowledgeEmbeddingRoutingRef,
  KnowledgeEmbeddingWorkRepository,
  runWithoutTenantContext,
  runWithoutTenantDatabaseScope,
  runWithSystemDatabaseScope,
  runWithTenantContext,
  runWithTenantDatabaseScope,
  type TenantScopeAwareDatabase,
  type TenantScopedDatabase,
} from '@agor/core/db';
import type { TenantID } from '@agor/core/types';
import { type EmbeddingProvider, OpenAIEmbeddingProvider } from '../knowledge/embeddings.js';
import { ensureKnowledgePgvectorStorage } from '../knowledge/pgvector.js';
import { KnowledgeEmbeddingBatchProcessor } from './knowledge-embedding-batch-processor.js';

export {
  buildKnowledgeEmbeddingReuseSql,
  isKnowledgeEmbeddingMaterializationSnapshotCurrent,
  mergeEmbeddingReuseIntoNextMetadata,
} from './knowledge-embedding-reuse.js';

const DEFAULT_TICK_MS = 5_000;
const DEFAULT_MAX_IDLE_MS = 60_000;
const DEFAULT_STARTUP_OFFSET_MS = 30_000;
const DEFAULT_SCAN_BATCH_SIZE = 32;
const DEFAULT_PER_TENANT_BATCH_SIZE = 8;
const DEFAULT_CLAIM_LEASE_MS = 5 * 60_000;
const DEFAULT_PROVIDER_TIMEOUT_MS = 90_000;
const DEFAULT_RETRY_BASE_MS = 5_000;
const DEFAULT_RETRY_MAX_MS = 5 * 60_000;
const MIN_CLAIM_COMMIT_MARGIN_MS = 30_000;
const SATURATED_DRAIN_BASE_MS = 150;
const SATURATED_DRAIN_JITTER_RATIO = 2 / 3;

export interface KnowledgeEmbeddingIndexerOptions {
  /** Static/single-tenant id. Undefined enables routing-only system discovery. */
  tenantId?: TenantID | string;
  /** Diagnostic only; the opaque per-batch token is the correctness fence. */
  workIdentity?: DistributedWorkIdentity;
  scanBatchSize?: number;
  perTenantBatchSize?: number;
  tickIntervalMs?: number;
  maxIdleIntervalMs?: number;
  startupOffsetMaxMs?: number;
  claimLeaseMs?: number;
  providerTimeoutMs?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  random?: () => number;
  provider?: EmbeddingProvider;
  generateClaimToken?: () => string;
  ensureStorage?: typeof ensureKnowledgePgvectorStorage;
  /** Test seam; production discovery always uses PostgreSQL/RLS. */
  discover?: () => Promise<KnowledgeEmbeddingRoutingRef[]>;
}

export interface KnowledgeEmbeddingIndexerStats {
  candidates: number;
  claimed: number;
  indexed: number;
  failures: number;
  saturated: boolean;
}

function emptyStats(): KnowledgeEmbeddingIndexerStats {
  return { candidates: 0, claimed: 0, indexed: 0, failures: 0, saturated: false };
}

export class KnowledgeEmbeddingIndexer {
  private timer: NodeJS.Timeout | null = null;
  private activeRun: Promise<void> | null = null;
  private running = false;
  private started = false;
  private shutdownRequested = false;
  private rerunRequested = false;
  private idleRounds = 0;
  private readonly scanBatchSize: number;
  private readonly perTenantBatchSize: number;
  private readonly tickIntervalMs: number;
  private readonly maxIdleIntervalMs: number;
  private readonly startupOffsetMaxMs: number;
  private readonly random: () => number;
  private readonly workIdentity: DistributedWorkIdentity;
  private readonly batchProcessor: KnowledgeEmbeddingBatchProcessor;

  constructor(
    private readonly db: TenantScopeAwareDatabase,
    private readonly options: KnowledgeEmbeddingIndexerOptions = {}
  ) {
    this.scanBatchSize = options.scanBatchSize ?? DEFAULT_SCAN_BATCH_SIZE;
    this.perTenantBatchSize = options.perTenantBatchSize ?? DEFAULT_PER_TENANT_BATCH_SIZE;
    this.tickIntervalMs = options.tickIntervalMs ?? DEFAULT_TICK_MS;
    this.maxIdleIntervalMs = options.maxIdleIntervalMs ?? DEFAULT_MAX_IDLE_MS;
    this.startupOffsetMaxMs = options.startupOffsetMaxMs ?? DEFAULT_STARTUP_OFFSET_MS;
    const claimLeaseMs = options.claimLeaseMs ?? DEFAULT_CLAIM_LEASE_MS;
    const providerTimeoutMs = options.providerTimeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS;
    const retryBaseMs = options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS;
    const retryMaxMs = options.retryMaxMs ?? DEFAULT_RETRY_MAX_MS;
    this.random = options.random ?? Math.random;
    this.workIdentity = options.workIdentity ?? {
      instanceId: 'daemon',
      bootId: `knowledge-${generateId()}`,
    };

    for (const [value, label] of [
      [this.scanBatchSize, 'scan batch size'],
      [this.perTenantBatchSize, 'per-tenant batch size'],
      [this.tickIntervalMs, 'tick interval'],
      [this.maxIdleIntervalMs, 'maximum idle interval'],
      [claimLeaseMs, 'claim lease'],
      [providerTimeoutMs, 'provider timeout'],
      [retryBaseMs, 'retry base'],
      [retryMaxMs, 'retry maximum'],
    ] as const) {
      if (!Number.isInteger(value) || value <= 0) {
        throw new Error(`Knowledge embedding ${label} must be a positive integer`);
      }
    }
    if (this.perTenantBatchSize > this.scanBatchSize) {
      throw new Error('Knowledge embedding per-tenant batch size cannot exceed scan batch size');
    }
    if (!Number.isInteger(this.startupOffsetMaxMs) || this.startupOffsetMaxMs < 0) {
      throw new Error('Knowledge embedding startup offset must be a non-negative integer');
    }
    if (this.maxIdleIntervalMs < this.tickIntervalMs) {
      throw new Error('Knowledge embedding maximum idle interval cannot be below tick interval');
    }
    if (providerTimeoutMs + MIN_CLAIM_COMMIT_MARGIN_MS > claimLeaseMs) {
      throw new Error(
        'Knowledge embedding claim lease must leave at least 30 seconds after its provider timeout'
      );
    }
    if (retryMaxMs < retryBaseMs) {
      throw new Error('Knowledge embedding retry maximum cannot be below retry base');
    }
    this.batchProcessor = new KnowledgeEmbeddingBatchProcessor(db, {
      perTenantBatchSize: this.perTenantBatchSize,
      claimLeaseMs,
      providerTimeoutMs,
      retryBaseMs,
      retryMaxMs,
      workIdentity: this.workIdentity,
      provider: options.provider ?? new OpenAIEmbeddingProvider(),
      generateClaimToken: options.generateClaimToken ?? generateId,
      ensureStorage: options.ensureStorage ?? ensureKnowledgePgvectorStorage,
      isShutdownRequested: () => this.shutdownRequested,
    });
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.shutdownRequested = false;
    this.schedule(initialWorkOffset(this.startupOffsetMaxMs, this.random()));
  }

  /**
   * Stop new scans, abort the local HTTP wait, and drain the current iteration.
   * Claims from an aborted request are intentionally retained until database
   * expiry because the provider may already have accepted the cost-bearing call.
   */
  async stop(): Promise<void> {
    this.started = false;
    this.shutdownRequested = true;
    this.rerunRequested = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.batchProcessor.abortProviderWait(
      new Error('Knowledge embedding indexer is shutting down')
    );
    if (this.activeRun) await this.activeRun;
  }

  private schedule(delayMs: number, replace = false): void {
    if (!this.started || this.shutdownRequested) return;
    if (this.timer) {
      if (!replace) return;
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      const run = this.runLoopIteration();
      this.activeRun = run;
      void run.finally(() => {
        if (this.activeRun === run) this.activeRun = null;
      });
    }, delayMs);
    this.timer.unref?.();
  }

  wake(): void {
    const afterCommit = () => {
      // Request timers inherit AsyncLocalStorage. A wake is only a local hint;
      // discovery must establish a fresh system/tenant scope after commit.
      runWithoutTenantContext(() =>
        runWithoutTenantDatabaseScope(() => {
          if (!this.started || this.shutdownRequested) return;
          if (this.running) {
            this.rerunRequested = true;
            return;
          }
          this.schedule(0, true);
        })
      );
    };
    if (!enqueueAfterTenantDatabaseCommit(afterCommit)) afterCommit();
  }

  private async runLoopIteration(): Promise<void> {
    let stats = emptyStats();
    try {
      stats = await this.tick();
      this.idleRounds = stats.candidates === 0 && stats.failures === 0 ? this.idleRounds + 1 : 0;
    } catch (error) {
      this.idleRounds += 1;
      console.warn(
        `[distributed-work.knowledge-index] event=scan_failed instance_id=${JSON.stringify(this.workIdentity.instanceId)} boot_id=${JSON.stringify(this.workIdentity.bootId)} error=${JSON.stringify(error instanceof Error ? error.message : String(error))}`
      );
    }
    if (!this.started || this.shutdownRequested) return;
    if (this.rerunRequested) {
      this.rerunRequested = false;
      this.schedule(0, true);
      return;
    }
    const delay = stats.saturated
      ? jitterDelay(SATURATED_DRAIN_BASE_MS, SATURATED_DRAIN_JITTER_RATIO, this.random())
      : stats.claimed > 0 || stats.failures > 0
        ? jitterDelay(this.tickIntervalMs, 0.2, this.random())
        : boundedBackoffDelay(
            this.idleRounds,
            {
              baseDelayMs: this.tickIntervalMs,
              maxDelayMs: this.maxIdleIntervalMs,
              jitterRatio: 0.2,
            },
            this.random()
          );
    this.schedule(delay);
  }

  async tick(): Promise<KnowledgeEmbeddingIndexerStats> {
    if (this.running) {
      this.rerunRequested = true;
      return emptyStats();
    }
    this.running = true;
    try {
      return await this.checkOnce();
    } finally {
      this.running = false;
    }
  }

  private async discoverRoutingRefs(): Promise<KnowledgeEmbeddingRoutingRef[]> {
    if (this.options.discover) return this.options.discover();
    const find = (scopedDb: TenantScopedDatabase) =>
      new KnowledgeEmbeddingWorkRepository(scopedDb).findRoutingRefs({
        limit: this.scanBatchSize,
        perTenantLimit: this.perTenantBatchSize,
      });
    if (this.options.tenantId) {
      return runWithTenantDatabaseScope(this.db, this.options.tenantId, find);
    }
    return runWithSystemDatabaseScope(
      this.db,
      'Knowledge embedding routing discovery',
      (systemDb) =>
        new KnowledgeEmbeddingWorkRepository(systemDb).findRoutingRefs({
          limit: this.scanBatchSize,
          perTenantLimit: this.perTenantBatchSize,
        }),
      { capability: 'knowledge_embedding_discovery' }
    );
  }

  /** One bounded, tenant-fair scan exposed for deterministic HA tests. */
  async checkOnce(): Promise<KnowledgeEmbeddingIndexerStats> {
    if (this.shutdownRequested) return emptyStats();
    if (!isPostgresDatabase(this.db)) return emptyStats();
    const refs = await this.discoverRoutingRefs();
    const stats: KnowledgeEmbeddingIndexerStats = {
      ...emptyStats(),
      candidates: refs.length,
      saturated: refs.length >= this.scanBatchSize,
    };
    const byTenant = new Map<string, KnowledgeEmbeddingRoutingRef[]>();
    for (const ref of refs) {
      const tenantId = String(this.options.tenantId ?? ref.tenant_id ?? '');
      if (!tenantId) {
        stats.failures += 1;
        console.error(
          `[distributed-work.knowledge-index] event=route_missing_tenant unit_id=${JSON.stringify(ref.unit_id)}`
        );
        continue;
      }
      const tenantRefs = byTenant.get(tenantId) ?? [];
      if (tenantRefs.length < this.perTenantBatchSize) tenantRefs.push(ref);
      byTenant.set(tenantId, tenantRefs);
    }

    for (const [tenantId, tenantRefs] of byTenant) {
      if (this.shutdownRequested) break;
      try {
        const result = await runWithTenantContext(tenantId, () =>
          this.batchProcessor.processTenantBatch(
            tenantId,
            tenantRefs.map((ref) => ref.unit_id)
          )
        );
        stats.claimed += result.claimed;
        stats.indexed += result.indexed;
      } catch (error) {
        stats.failures += 1;
        console.warn(
          `[distributed-work.knowledge-index] event=tenant_batch_failed instance_id=${JSON.stringify(this.workIdentity.instanceId)} boot_id=${JSON.stringify(this.workIdentity.bootId)} tenant_id=${JSON.stringify(tenantId)} error=${JSON.stringify(error instanceof Error ? error.message : String(error))}`
        );
      }
    }
    return stats;
  }

  /** Static/ambient-tenant compatibility seam used by focused probes. */
  async indexBatch(): Promise<number> {
    if (!isPostgresDatabase(this.db)) return 0;
    const tenantId = this.options.tenantId ?? getCurrentTenantId();
    if (!tenantId) throw new Error('Knowledge embedding indexBatch requires a tenant context');
    return runWithTenantContext(tenantId, async () => {
      const refs = await runWithTenantDatabaseScope(this.db, tenantId, (scopedDb) =>
        new KnowledgeEmbeddingWorkRepository(scopedDb).findRoutingRefs({
          limit: this.perTenantBatchSize,
          perTenantLimit: this.perTenantBatchSize,
        })
      );
      const result = await this.batchProcessor.processTenantBatch(
        tenantId,
        refs.map((ref) => ref.unit_id)
      );
      return result.indexed;
    });
  }
}
