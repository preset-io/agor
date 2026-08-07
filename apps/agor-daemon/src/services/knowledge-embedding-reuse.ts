import {
  executeRaw,
  inArray,
  kbDocumentUnits,
  kbDocumentVersions,
  select,
  sql,
  type TenantScopedDatabase,
  update,
} from '@agor/core/db';
import type { KnowledgeSemanticPolicy } from '@agor/core/types';

export interface ReusedEmbeddingRow {
  unit_id: string;
  new_version_id: string | null;
  previous_version_id: string | null;
}

const EMBEDDING_REUSE_INTO_NEXT_METADATA_KEY = 'embedding_reuse_into_next';

export interface EmbeddingReuseIntoNextMetadataUpdate {
  targetVersionId: string;
  embeddingSpaceId: string;
  provider: string;
  model: string;
  dimensions: number;
  reusedChunks: number;
  totalChunks: number;
  updatedAt: string;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function sameEmbeddingReuseScope(
  existing: Record<string, unknown>,
  update: EmbeddingReuseIntoNextMetadataUpdate
): boolean {
  return (
    existing.target_version_id === update.targetVersionId &&
    existing.embedding_space_id === update.embeddingSpaceId &&
    existing.provider === update.provider &&
    existing.model === update.model &&
    existing.dimensions === update.dimensions
  );
}

export function isKnowledgeEmbeddingMaterializationSnapshotCurrent(
  snapshot: KnowledgeSemanticPolicy,
  current: KnowledgeSemanticPolicy,
  snapshotApiKey: string,
  currentApiKey: string | null
): boolean {
  return (
    snapshotApiKey === currentApiKey &&
    snapshot.enabled === current.enabled &&
    snapshot.provider === current.provider &&
    snapshot.model === current.model &&
    snapshot.dimensions === current.dimensions &&
    snapshot.indexing.paused === current.indexing.paused &&
    JSON.stringify(snapshot.chunking) === JSON.stringify(current.chunking)
  );
}

export function mergeEmbeddingReuseIntoNextMetadata(
  metadata: Record<string, unknown> | null | undefined,
  update: EmbeddingReuseIntoNextMetadataUpdate
): Record<string, unknown> {
  const existingMetadata = asRecord(metadata);
  const existingReuse = asRecord(existingMetadata[EMBEDDING_REUSE_INTO_NEXT_METADATA_KEY]);
  const previousReused = sameEmbeddingReuseScope(existingReuse, update)
    ? Number(existingReuse.reused_chunks) || 0
    : 0;

  return {
    ...existingMetadata,
    [EMBEDDING_REUSE_INTO_NEXT_METADATA_KEY]: {
      target_version_id: update.targetVersionId,
      embedding_space_id: update.embeddingSpaceId,
      provider: update.provider,
      model: update.model,
      dimensions: update.dimensions,
      reused_chunks: Math.min(update.totalChunks, previousReused + update.reusedChunks),
      total_chunks: update.totalChunks,
      updated_at: update.updatedAt,
    },
  };
}

export interface KnowledgeEmbeddingReuseSqlParams {
  embeddingSpaceId: string;
  model: string;
  dimensions: number;
  limit: number;
  claimToken: string;
}

/**
 * Reuse is a database-only completion path and therefore runs inside the short
 * claim transaction. It observes the same live token/current-version fence as
 * provider-backed completion without incurring an external side effect.
 */
export function buildKnowledgeEmbeddingReuseSql(params: KnowledgeEmbeddingReuseSqlParams) {
  return sql`WITH pending AS (
            SELECT u.unit_id, u.version_id, u.content_md5
            FROM kb_document_units AS u
            JOIN kb_documents AS d
              ON d.document_id = u.document_id
             AND d.current_version_id = u.version_id
             AND d.archived = false
            JOIN kb_namespaces AS n
              ON n.namespace_id = d.namespace_id
             AND n.archived = false
            WHERE u.embedding_status IN ('pending', 'stale', 'error')
              AND u.content_text IS NOT NULL
              AND u.content_md5 IS NOT NULL
              AND u.embedding_claim_token = ${params.claimToken}
              AND u.embedding_claim_expires_at > clock_timestamp()
            ORDER BY u.created_at, u.unit_id
            LIMIT ${params.limit}
          ), candidates AS (
            SELECT DISTINCT ON (p.unit_id)
              p.unit_id AS new_unit_id,
              p.version_id AS new_version_id,
              prev_v.version_id AS previous_version_id,
              e.content_sha256,
              p.content_md5 AS new_embedding_hash,
              e.embedding,
              e.token_count
            FROM pending p
            JOIN kb_document_versions new_v
              ON new_v.version_id = p.version_id
            LEFT JOIN kb_document_versions prev_v
              ON prev_v.document_id = new_v.document_id
             AND prev_v.version_number = new_v.version_number - 1
            JOIN kb_document_units old_u
              ON old_u.content_md5 = p.content_md5
             AND old_u.unit_id <> p.unit_id
             AND old_u.embedding_status = 'ready'
             AND old_u.embedding_model = ${params.model}
             AND old_u.embedding_dimensions = ${params.dimensions}
            JOIN kb_unit_embeddings e
              ON e.unit_id = old_u.unit_id
             AND e.embedding_space_id = ${params.embeddingSpaceId}
            ORDER BY p.unit_id, old_u.updated_at DESC NULLS LAST, old_u.created_at DESC
          ), upserted AS (
            INSERT INTO kb_unit_embeddings (
              tenant_id,
              unit_id,
              embedding_space_id,
              content_sha256,
              embedding,
              token_count,
              created_at,
              updated_at
            )
            SELECT
              COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default'),
              new_unit_id,
              ${params.embeddingSpaceId},
              content_sha256,
              embedding,
              token_count,
              now(),
              now()
            FROM candidates
            ON CONFLICT (unit_id, embedding_space_id) DO UPDATE SET
              content_sha256 = EXCLUDED.content_sha256,
              embedding = EXCLUDED.embedding,
              token_count = EXCLUDED.token_count,
              updated_at = now()
            RETURNING unit_id
          )
          UPDATE kb_document_units u
          SET embedding_status = 'ready',
              embedding_model = ${params.model},
              embedding_dimensions = ${params.dimensions},
              embedding_hash = candidates.new_embedding_hash,
              embedding_error = NULL,
              embedding_claim_token = NULL,
              embedding_claimed_at = NULL,
              embedding_claim_expires_at = NULL,
              embedding_claim_instance_id = NULL,
              embedding_claim_boot_id = NULL,
              embedding_failure_count = 0,
              embedding_retry_at = NULL,
              updated_at = now()
          FROM upserted
          JOIN candidates ON candidates.new_unit_id = upserted.unit_id
          WHERE u.unit_id = upserted.unit_id
            AND u.embedding_claim_token = ${params.claimToken}
            AND u.embedding_claim_expires_at > clock_timestamp()
          RETURNING
            u.unit_id,
            candidates.new_version_id,
            candidates.previous_version_id`;
}

function rowsOf(result: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(result)) return result as Array<Record<string, unknown>>;
  const rows = (result as { rows?: unknown[] } | undefined)?.rows;
  return Array.isArray(rows) ? (rows as Array<Record<string, unknown>>) : [];
}

export class KnowledgeEmbeddingReuseService {
  constructor(private readonly db: TenantScopedDatabase) {}

  async reuseExistingEmbeddings(
    params: KnowledgeEmbeddingReuseSqlParams
  ): Promise<ReusedEmbeddingRow[]> {
    const result = await executeRaw(this.db, buildKnowledgeEmbeddingReuseSql(params));
    return rowsOf(result).map((row) => ({
      unit_id: String(row.unit_id ?? ''),
      new_version_id: row.new_version_id ? String(row.new_version_id) : null,
      previous_version_id: row.previous_version_id ? String(row.previous_version_id) : null,
    }));
  }

  async recordEmbeddingReuseIntoNext(params: {
    rows: ReusedEmbeddingRow[];
    embeddingSpaceId: string;
    provider: string;
    model: string;
    dimensions: number;
  }): Promise<void> {
    const countsByPair = new Map<
      string,
      { previousVersionId: string; targetVersionId: string; reusedChunks: number }
    >();
    for (const row of params.rows) {
      if (!row.previous_version_id || !row.new_version_id) continue;
      const key = `${row.previous_version_id}:${row.new_version_id}`;
      const current = countsByPair.get(key) ?? {
        previousVersionId: row.previous_version_id,
        targetVersionId: row.new_version_id,
        reusedChunks: 0,
      };
      current.reusedChunks += 1;
      countsByPair.set(key, current);
    }
    if (countsByPair.size === 0) return;

    const targetVersionIds = [
      ...new Set([...countsByPair.values()].map((item) => item.targetVersionId)),
    ];
    const totalRows = (await select(this.db, {
      version_id: kbDocumentUnits.version_id,
      count: sql<number>`count(*)`,
    })
      .from(kbDocumentUnits)
      .where(inArray(kbDocumentUnits.version_id, targetVersionIds))
      .groupBy(kbDocumentUnits.version_id)
      .all()) as Array<{ version_id: string; count: number | string }>;
    const totalByVersion = new Map(
      totalRows.map((row) => [row.version_id, Number(row.count) || 0])
    );
    const previousVersionIds = [
      ...new Set([...countsByPair.values()].map((item) => item.previousVersionId)),
    ];
    const previousRows = (await select(this.db)
      .from(kbDocumentVersions)
      .where(inArray(kbDocumentVersions.version_id, previousVersionIds))
      .all()) as Array<typeof kbDocumentVersions.$inferSelect>;
    const previousById = new Map(previousRows.map((row) => [row.version_id, row]));
    const updatedAt = new Date().toISOString();

    for (const item of countsByPair.values()) {
      const previous = previousById.get(item.previousVersionId);
      if (!previous) continue;
      await update(this.db, kbDocumentVersions)
        .set({
          metadata: mergeEmbeddingReuseIntoNextMetadata(
            previous.metadata as Record<string, unknown> | null,
            {
              targetVersionId: item.targetVersionId,
              embeddingSpaceId: params.embeddingSpaceId,
              provider: params.provider,
              model: params.model,
              dimensions: params.dimensions,
              reusedChunks: item.reusedChunks,
              totalChunks: totalByVersion.get(item.targetVersionId) ?? 0,
              updatedAt,
            }
          ),
        })
        .where(sql`${kbDocumentVersions.version_id} = ${item.previousVersionId}`)
        .run();
    }
  }
}
