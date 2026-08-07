import { sql } from 'drizzle-orm';
import type { DistributedWorkIdentity } from '../../coordination';
import type { KnowledgeDocumentUnitID, TenantID } from '../../types';
import type { Database } from '../client';
import { executeRaw, isPostgresDatabase } from '../database-wrapper';

export interface KnowledgeEmbeddingRoutingRef {
  tenant_id?: TenantID | string;
  unit_id: KnowledgeDocumentUnitID;
  eligible_at: Date;
}

export interface KnowledgeEmbeddingClaim {
  unit_id: KnowledgeDocumentUnitID;
  document_id: string;
  version_id: string;
  content_text: string;
  content_md5: string | null;
  claim_token: string;
  claim_generation: number;
  claim_expires_at: Date;
  failure_count: number;
}

export interface KnowledgeEmbeddingCompletion {
  unitId: KnowledgeDocumentUnitID | string;
  claimGeneration: number;
  contentText: string;
  contentMd5: string | null;
  contentSha256: string;
  embedding: string;
  tokenCount?: number | null;
}

function rowsOf(result: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(result)) return result as Array<Record<string, unknown>>;
  const rows = (result as { rows?: unknown[] } | undefined)?.rows;
  return Array.isArray(rows) ? (rows as Array<Record<string, unknown>>) : [];
}

function asDate(value: unknown): Date {
  return value instanceof Date ? value : new Date(String(value));
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0)
    throw new Error(`${label} must be a positive integer`);
}

function unitFilter(unitIds: readonly (KnowledgeDocumentUnitID | string)[]) {
  return sql`u.unit_id IN (${sql.join(
    unitIds.map((unitId) => sql`${unitId}`),
    sql`, `
  )})`;
}

/**
 * PostgreSQL-owned claim and fencing transitions for Knowledge embedding work.
 *
 * This repository deliberately does not own the scanner loop, semantic policy,
 * provider, or retry classification. System-scope discovery returns routing
 * refs only. Every claim/commit/failure transition must execute in the trusted
 * tenant scope represented by those refs.
 */
export class KnowledgeEmbeddingWorkRepository {
  constructor(private readonly db: Database) {}

  /**
   * Return a bounded, tenant-fair page of claimable routing references.
   * Ranking emits one candidate per tenant before a second candidate from any
   * tenant, up to perTenantLimit. Atomic claim remains the correctness fence.
   */
  async findRoutingRefs(options: {
    limit: number;
    perTenantLimit: number;
  }): Promise<KnowledgeEmbeddingRoutingRef[]> {
    assertPositiveInteger(options.limit, 'Knowledge embedding discovery limit');
    assertPositiveInteger(options.perTenantLimit, 'Knowledge embedding per-tenant limit');
    if (!isPostgresDatabase(this.db)) return [];

    const result = await executeRaw(
      this.db,
      sql`WITH eligible AS (
            SELECT
              tenant_id,
              unit_id,
              COALESCE(embedding_retry_at, created_at) AS eligible_at,
              row_number() OVER (
                PARTITION BY tenant_id
                ORDER BY COALESCE(embedding_retry_at, created_at), created_at, unit_id
              ) AS tenant_rank
            FROM kb_document_units
            WHERE content_text IS NOT NULL
              AND (
                embedding_status IN ('pending', 'stale')
                OR (
                  embedding_status = 'error'
                  AND (embedding_retry_at IS NULL OR embedding_retry_at <= clock_timestamp())
                )
              )
              AND (
                embedding_claim_token IS NULL
                OR embedding_claim_expires_at IS NULL
                OR embedding_claim_expires_at <= clock_timestamp()
              )
          )
          SELECT tenant_id, unit_id, eligible_at
          FROM eligible
          WHERE tenant_rank <= ${options.perTenantLimit}
          ORDER BY tenant_rank, eligible_at, tenant_id, unit_id
          LIMIT ${options.limit}`
    );

    return rowsOf(result).map((row) => ({
      tenant_id: row.tenant_id ? String(row.tenant_id) : undefined,
      unit_id: String(row.unit_id) as KnowledgeDocumentUnitID,
      eligible_at: asDate(row.eligible_at),
    }));
  }

  /**
   * Atomically retire obsolete routing refs and claim current chunks. The
   * transaction is caller-owned and must also hold the tenant semantic-policy
   * aggregate lock so settings mutation and claim admission cannot interleave.
   */
  async claimCurrentUnits(input: {
    unitIds: readonly (KnowledgeDocumentUnitID | string)[];
    claimToken: string;
    leaseMs: number;
    identity: DistributedWorkIdentity;
    limit: number;
  }): Promise<KnowledgeEmbeddingClaim[]> {
    if (!isPostgresDatabase(this.db) || input.unitIds.length === 0) return [];
    assertPositiveInteger(input.leaseMs, 'Knowledge embedding lease');
    assertPositiveInteger(input.limit, 'Knowledge embedding claim limit');
    if (!input.claimToken.trim()) throw new Error('Knowledge embedding claim token is required');
    const filter = unitFilter(input.unitIds);

    // Reconcile old-version and archived routing rows so they cannot monopolize
    // a tenant's fair-share slot on every scan. Ready historical vectors remain
    // intact for version history; only unmaterialized work is retired.
    await executeRaw(
      this.db,
      sql`UPDATE kb_document_units AS u
          SET embedding_status = 'not_configured',
              embedding_error = NULL,
              embedding_claim_token = NULL,
              embedding_claim_generation = u.embedding_claim_generation + 1,
              embedding_claimed_at = NULL,
              embedding_claim_expires_at = NULL,
              embedding_claim_instance_id = NULL,
              embedding_claim_boot_id = NULL,
              embedding_retry_at = NULL,
              updated_at = CURRENT_TIMESTAMP
          WHERE ${filter}
            AND u.embedding_status IN ('pending', 'stale', 'error')
            AND NOT EXISTS (
              SELECT 1
              FROM kb_documents AS d
              JOIN kb_namespaces AS n ON n.namespace_id = d.namespace_id
              WHERE d.document_id = u.document_id
                AND d.current_version_id = u.version_id
                AND d.archived = false
                AND n.archived = false
            )`
    );

    const result = await executeRaw(
      this.db,
      sql`WITH claimable AS (
            SELECT u.unit_id
            FROM kb_document_units AS u
            JOIN kb_documents AS d
              ON d.document_id = u.document_id
             AND d.current_version_id = u.version_id
             AND d.archived = false
            JOIN kb_namespaces AS n
              ON n.namespace_id = d.namespace_id
             AND n.archived = false
            WHERE ${filter}
              AND u.content_text IS NOT NULL
              AND (
                u.embedding_status IN ('pending', 'stale')
                OR (
                  u.embedding_status = 'error'
                  AND (u.embedding_retry_at IS NULL OR u.embedding_retry_at <= clock_timestamp())
                )
              )
              AND (
                u.embedding_claim_token IS NULL
                OR u.embedding_claim_expires_at IS NULL
                OR u.embedding_claim_expires_at <= clock_timestamp()
              )
            ORDER BY COALESCE(u.embedding_retry_at, u.created_at), u.created_at, u.unit_id
            FOR UPDATE OF u SKIP LOCKED
            LIMIT ${input.limit}
          )
          UPDATE kb_document_units AS u
          SET embedding_claim_token = ${input.claimToken},
              embedding_claim_generation = u.embedding_claim_generation + 1,
              embedding_claimed_at = clock_timestamp(),
              embedding_claim_expires_at = clock_timestamp() + (${input.leaseMs} * interval '1 millisecond'),
              embedding_claim_instance_id = ${input.identity.instanceId},
              embedding_claim_boot_id = ${input.identity.bootId},
              updated_at = CURRENT_TIMESTAMP
          FROM claimable
          WHERE u.unit_id = claimable.unit_id
          RETURNING
            u.unit_id,
            u.document_id,
            u.version_id,
            u.content_text,
            u.content_md5,
            u.embedding_claim_token,
            u.embedding_claim_generation,
            u.embedding_claim_expires_at,
            u.embedding_failure_count`
    );

    return rowsOf(result).map((row) => ({
      unit_id: String(row.unit_id) as KnowledgeDocumentUnitID,
      document_id: String(row.document_id),
      version_id: String(row.version_id),
      content_text: String(row.content_text),
      content_md5: row.content_md5 === null ? null : String(row.content_md5),
      claim_token: String(row.embedding_claim_token),
      claim_generation: Number(row.embedding_claim_generation),
      claim_expires_at: asDate(row.embedding_claim_expires_at),
      failure_count: Number(row.embedding_failure_count) || 0,
    }));
  }

  /**
   * Commit vectors only while every unit still has the exact live claim,
   * content snapshot, current document version, and unexpired database lease.
   */
  async completeClaims(input: {
    claimToken: string;
    embeddingSpaceId: string;
    model: string;
    dimensions: number;
    completions: readonly KnowledgeEmbeddingCompletion[];
  }): Promise<KnowledgeDocumentUnitID[]> {
    if (!isPostgresDatabase(this.db) || input.completions.length === 0) return [];
    const completed: KnowledgeDocumentUnitID[] = [];
    const ordered = [...input.completions].sort((a, b) =>
      String(a.unitId).localeCompare(String(b.unitId))
    );

    for (const item of ordered) {
      const updated = await executeRaw(
        this.db,
        sql`UPDATE kb_document_units AS u
            SET embedding_status = 'ready',
                embedding_model = ${input.model},
                embedding_dimensions = ${input.dimensions},
                embedding_hash = u.content_md5,
                embedding_error = NULL,
                embedding_claim_token = NULL,
                embedding_claimed_at = NULL,
                embedding_claim_expires_at = NULL,
                embedding_claim_instance_id = NULL,
                embedding_claim_boot_id = NULL,
                embedding_failure_count = 0,
                embedding_retry_at = NULL,
                updated_at = CURRENT_TIMESTAMP
            WHERE u.unit_id = ${item.unitId}
              AND u.embedding_claim_token = ${input.claimToken}
              AND u.embedding_claim_generation = ${item.claimGeneration}
              AND u.embedding_claim_expires_at > clock_timestamp()
              AND u.content_text IS NOT DISTINCT FROM ${item.contentText}
              AND u.content_md5 IS NOT DISTINCT FROM ${item.contentMd5}
              AND EXISTS (
                SELECT 1
                FROM kb_documents AS d
                JOIN kb_namespaces AS n ON n.namespace_id = d.namespace_id
                WHERE d.document_id = u.document_id
                  AND d.current_version_id = u.version_id
                  AND d.archived = false
                  AND n.archived = false
              )
            RETURNING u.unit_id`
      );
      const unitId = rowsOf(updated)[0]?.unit_id;
      if (!unitId) continue;

      await executeRaw(
        this.db,
        sql`INSERT INTO kb_unit_embeddings (
              tenant_id,
              unit_id,
              embedding_space_id,
              content_sha256,
              embedding,
              token_count,
              created_at,
              updated_at
            )
            VALUES (
              COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default'),
              ${item.unitId},
              ${input.embeddingSpaceId},
              ${item.contentSha256},
              ${item.embedding}::vector,
              ${item.tokenCount ?? null},
              CURRENT_TIMESTAMP,
              CURRENT_TIMESTAMP
            )
            ON CONFLICT (unit_id, embedding_space_id) DO UPDATE SET
              content_sha256 = EXCLUDED.content_sha256,
              embedding = EXCLUDED.embedding,
              token_count = EXCLUDED.token_count,
              updated_at = CURRENT_TIMESTAMP`
      );
      completed.push(String(unitId) as KnowledgeDocumentUnitID);
    }
    return completed;
  }

  /** Record a retryable provider failure and release only the exact live claim. */
  async failClaims(input: {
    claimToken: string;
    claims: readonly Pick<KnowledgeEmbeddingClaim, 'unit_id' | 'claim_generation'>[];
    error: string;
    baseRetryMs: number;
    maxRetryMs: number;
  }): Promise<KnowledgeDocumentUnitID[]> {
    if (!isPostgresDatabase(this.db) || input.claims.length === 0) return [];
    assertPositiveInteger(input.baseRetryMs, 'Knowledge embedding retry base');
    assertPositiveInteger(input.maxRetryMs, 'Knowledge embedding retry maximum');
    if (input.maxRetryMs < input.baseRetryMs) {
      throw new Error('Knowledge embedding retry maximum must be at least its base');
    }
    const failed: KnowledgeDocumentUnitID[] = [];
    const ordered = [...input.claims].sort((a, b) =>
      String(a.unit_id).localeCompare(String(b.unit_id))
    );
    for (const claim of ordered) {
      const result = await executeRaw(
        this.db,
        sql`UPDATE kb_document_units AS u
            SET embedding_status = 'error',
                embedding_error = ${input.error},
                embedding_claim_token = NULL,
                embedding_claimed_at = NULL,
                embedding_claim_expires_at = NULL,
                embedding_claim_instance_id = NULL,
                embedding_claim_boot_id = NULL,
                embedding_failure_count = u.embedding_failure_count + 1,
                embedding_retry_at = clock_timestamp() + (
                  LEAST(
                    ${input.maxRetryMs},
                    ${input.baseRetryMs} * power(2, LEAST(u.embedding_failure_count, 10))
                  ) * interval '1 millisecond'
                ),
                updated_at = CURRENT_TIMESTAMP
            WHERE u.unit_id = ${claim.unit_id}
              AND u.embedding_claim_token = ${input.claimToken}
              AND u.embedding_claim_generation = ${claim.claim_generation}
              AND u.embedding_claim_expires_at > clock_timestamp()
              AND EXISTS (
                SELECT 1
                FROM kb_documents AS d
                JOIN kb_namespaces AS n ON n.namespace_id = d.namespace_id
                WHERE d.document_id = u.document_id
                  AND d.current_version_id = u.version_id
                  AND d.archived = false
                  AND n.archived = false
              )
            RETURNING u.unit_id`
      );
      const unitId = rowsOf(result)[0]?.unit_id;
      if (unitId) failed.push(String(unitId) as KnowledgeDocumentUnitID);
    }
    return failed;
  }
}
