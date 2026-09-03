/**
 * PostgreSQL authority for executor-session bearer JWTs.
 *
 * Only a SHA-256 fingerprint of the signed, high-entropy bearer is persisted.
 * Callers must verify the JWT signature and derive the trusted tenant/user/
 * resource claims before entering this repository. RLS is defense in depth;
 * every mutation also carries an explicit tenant predicate.
 */

import { sql } from 'drizzle-orm';
import type { Database } from '../client';
import { executeRaw, insert, isPostgresDatabase } from '../database-wrapper';
import { sanitizeDbError } from '../sanitize-error';
import { executorSessionTokenAuthorities } from '../schema';
import { RepositoryError } from './base';

const TOKEN_FINGERPRINT = /^[a-f0-9]{64}$/;

export interface ExecutorSessionTokenAuthorityIssue {
  tenantId: string;
  tokenFingerprint: string;
  tokenType: string;
  purpose: string;
  sessionId: string;
  taskId: string | null;
  branchId: string | null;
  userId: string;
  createdAt: Date;
  expiresAt: Date;
  /** Values <= 0 preserve the existing unlimited-use contract. */
  maxUses: number;
}

export interface ExecutorSessionTokenAuthorityClaim {
  tenantId: string;
  tokenFingerprint: string;
  tokenType: string;
  purpose: string;
  sessionId: string;
  taskId: string | null;
  branchId: string | null;
  userId: string;
}

/** Exact already-authenticated Task credential checked by the heartbeat hot path. */
export interface CurrentTaskExecutorSessionTokenAuthority {
  tenantId: string;
  tokenFingerprint: string;
  sessionId: string;
  taskId: string;
  branchId: string;
  userId: string;
}

export interface ConsumedExecutorSessionTokenAuthority {
  sessionId: string;
  taskId: string | null;
  branchId: string | null;
  userId: string;
}

function rowsOf(result: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(result)) return result as Array<Record<string, unknown>>;
  const rows = (result as { rows?: unknown[] } | undefined)?.rows;
  return Array.isArray(rows) ? (rows as Array<Record<string, unknown>>) : [];
}

function assertFingerprint(value: string): void {
  if (!TOKEN_FINGERPRINT.test(value)) {
    throw new RepositoryError('Executor session token fingerprint is invalid');
  }
}

function assertIssue(input: ExecutorSessionTokenAuthorityIssue): void {
  assertFingerprint(input.tokenFingerprint);
  if (!input.tenantId || !input.tokenType || !input.purpose || !input.sessionId || !input.userId) {
    throw new RepositoryError('Executor session token authority scope is incomplete');
  }
  if (!Number.isInteger(input.maxUses)) {
    throw new RepositoryError('Executor session token max uses must be an integer');
  }
  if (
    !Number.isFinite(input.createdAt.getTime()) ||
    !Number.isFinite(input.expiresAt.getTime()) ||
    input.expiresAt <= input.createdAt
  ) {
    throw new RepositoryError('Executor session token authority lifetime is invalid');
  }
}

function databaseFailure(operation: string, error: unknown): RepositoryError {
  // Drizzle errors can carry the SQL and bound fingerprint in params. Retain
  // only the repository operation plus sanitized database metadata.
  return new RepositoryError(
    `Executor session token authority ${operation} failed`,
    sanitizeDbError(error)
  );
}

function mapConsumed(row: Record<string, unknown>): ConsumedExecutorSessionTokenAuthority | null {
  if (
    typeof row.session_id !== 'string' ||
    typeof row.user_id !== 'string' ||
    (row.task_id !== null && typeof row.task_id !== 'string') ||
    (row.branch_id !== null && typeof row.branch_id !== 'string')
  ) {
    return null;
  }
  return {
    sessionId: row.session_id,
    taskId: row.task_id,
    branchId: row.branch_id,
    userId: row.user_id,
  };
}

/**
 * PostgreSQL-only token authority repository.
 *
 * Bounded-use claims use one conditional UPDATE. PostgreSQL rechecks the
 * `use_count < max_uses` predicate after a competing row update, so at most the
 * configured number of callers can succeed across daemon processes. Unlimited
 * tokens take the read-only arm and retain the existing no-counter-mutation
 * behavior used by executor reconnects and per-RPC authentication.
 */
export class ExecutorSessionTokenAuthorityRepository {
  constructor(private readonly db: Database) {
    if (!isPostgresDatabase(db)) {
      throw new RepositoryError('Executor session token authority requires PostgreSQL');
    }
  }

  async issue(input: ExecutorSessionTokenAuthorityIssue): Promise<void> {
    assertIssue(input);
    try {
      await insert(this.db, executorSessionTokenAuthorities)
        .values({
          tenant_id: input.tenantId,
          token_fingerprint: input.tokenFingerprint,
          token_type: input.tokenType,
          purpose: input.purpose,
          session_id: input.sessionId,
          task_id: input.taskId,
          branch_id: input.branchId,
          user_id: input.userId,
          created_at: input.createdAt,
          expires_at: input.expiresAt,
          max_uses: input.maxUses,
          use_count: 0,
        })
        .run();
    } catch (error) {
      throw databaseFailure('issuance', error);
    }
  }

  async validateAndConsume(
    input: ExecutorSessionTokenAuthorityClaim
  ): Promise<ConsumedExecutorSessionTokenAuthority | null> {
    assertFingerprint(input.tokenFingerprint);
    try {
      const result = await executeRaw(
        this.db,
        sql`
          WITH consumed AS (
            UPDATE ${executorSessionTokenAuthorities}
            SET use_count = use_count + 1,
                last_used_at = CURRENT_TIMESTAMP
            WHERE tenant_id = ${input.tenantId}
              AND token_fingerprint = ${input.tokenFingerprint}
              AND token_type = ${input.tokenType}
              AND purpose = ${input.purpose}
              AND session_id = ${input.sessionId}
              AND task_id IS NOT DISTINCT FROM ${input.taskId}
              AND branch_id IS NOT DISTINCT FROM ${input.branchId}
              AND user_id = ${input.userId}
              AND revoked_at IS NULL
              AND expires_at > CURRENT_TIMESTAMP
              AND max_uses > 0
              AND use_count < max_uses
            RETURNING session_id, task_id, branch_id, user_id
          ), unlimited AS (
            SELECT session_id, task_id, branch_id, user_id
            FROM ${executorSessionTokenAuthorities}
            WHERE tenant_id = ${input.tenantId}
              AND token_fingerprint = ${input.tokenFingerprint}
              AND token_type = ${input.tokenType}
              AND purpose = ${input.purpose}
              AND session_id = ${input.sessionId}
              AND task_id IS NOT DISTINCT FROM ${input.taskId}
              AND branch_id IS NOT DISTINCT FROM ${input.branchId}
              AND user_id = ${input.userId}
              AND revoked_at IS NULL
              AND expires_at > CURRENT_TIMESTAMP
              AND max_uses <= 0
          )
          SELECT session_id, task_id, branch_id, user_id FROM consumed
          UNION ALL
          SELECT session_id, task_id, branch_id, user_id FROM unlimited
          LIMIT 1
        `
      );
      const row = rowsOf(result)[0];
      return row ? mapConsumed(row) : null;
    } catch (error) {
      throw databaseFailure('validation', error);
    }
  }

  /**
   * Revalidate one task-scoped credential without consuming another token use.
   *
   * The fingerprint primary key is the first and only candidate lookup. The
   * remaining predicates prove that the authenticated socket's durable row is
   * still current for the exact tenant/principal/resource tuple.
   */
  async isCurrent(input: CurrentTaskExecutorSessionTokenAuthority): Promise<boolean> {
    assertFingerprint(input.tokenFingerprint);
    if (!input.tenantId || !input.sessionId || !input.taskId || !input.branchId || !input.userId) {
      throw new RepositoryError('Executor task token authority scope is incomplete');
    }
    try {
      const result = await executeRaw(
        this.db,
        sql`
          SELECT 1 AS current
          FROM ${executorSessionTokenAuthorities}
          WHERE tenant_id = ${input.tenantId}
            AND token_fingerprint = ${input.tokenFingerprint}
            AND session_id = ${input.sessionId}
            AND task_id = ${input.taskId}
            AND branch_id = ${input.branchId}
            AND user_id = ${input.userId}
            AND revoked_at IS NULL
            AND expires_at > CURRENT_TIMESTAMP
          LIMIT 1
        `
      );
      return rowsOf(result).length === 1;
    } catch (error) {
      throw databaseFailure('current-authority check', error);
    }
  }

  /**
   * Read one retained revoked Task authority for the dedicated workload
   * completion receipt path. This deliberately never authenticates a generic
   * Task read/write and never changes the tombstone.
   */
  async findRevoked(
    input: ExecutorSessionTokenAuthorityClaim
  ): Promise<ConsumedExecutorSessionTokenAuthority | null> {
    assertFingerprint(input.tokenFingerprint);
    try {
      const result = await executeRaw(
        this.db,
        sql`
          SELECT session_id, task_id, branch_id, user_id
          FROM ${executorSessionTokenAuthorities}
          WHERE tenant_id = ${input.tenantId}
            AND token_fingerprint = ${input.tokenFingerprint}
            AND token_type = ${input.tokenType}
            AND purpose = ${input.purpose}
            AND session_id = ${input.sessionId}
            AND task_id IS NOT DISTINCT FROM ${input.taskId}
            AND branch_id IS NOT DISTINCT FROM ${input.branchId}
            AND user_id = ${input.userId}
            AND revoked_at IS NOT NULL
            AND expires_at > CURRENT_TIMESTAMP
          LIMIT 1
        `
      );
      return mapConsumed(rowsOf(result)[0] ?? {});
    } catch (error) {
      throw databaseFailure('revoked receipt lookup', error);
    }
  }

  async revoke(tokenFingerprint: string, tenantId: string): Promise<boolean> {
    assertFingerprint(tokenFingerprint);
    try {
      const result = await executeRaw(
        this.db,
        sql`
          WITH revoked AS (
            UPDATE ${executorSessionTokenAuthorities}
            SET revoked_at = CURRENT_TIMESTAMP
            WHERE tenant_id = ${tenantId}
              AND token_fingerprint = ${tokenFingerprint}
              AND revoked_at IS NULL
            RETURNING 1
          )
          SELECT count(*) AS count FROM revoked
        `
      );
      return Number(rowsOf(result)[0]?.count ?? 0) > 0;
    } catch (error) {
      throw databaseFailure('revocation', error);
    }
  }

  /** Revoke every credential issued for one exact Task and return only fingerprints. */
  async revokeByTask(taskId: string, tenantId: string): Promise<string[]> {
    if (!taskId || !tenantId) {
      throw new RepositoryError('Executor task token revocation scope is incomplete');
    }
    try {
      const result = await executeRaw(
        this.db,
        sql`
          UPDATE ${executorSessionTokenAuthorities}
          SET revoked_at = CURRENT_TIMESTAMP
          WHERE tenant_id = ${tenantId}
            AND task_id = ${taskId}
            AND revoked_at IS NULL
          RETURNING token_fingerprint
        `
      );
      return rowsOf(result).map((row) => {
        if (typeof row.token_fingerprint !== 'string') {
          throw new RepositoryError('Executor task token revocation returned invalid authority');
        }
        assertFingerprint(row.token_fingerprint);
        return row.token_fingerprint;
      });
    } catch (error) {
      if (error instanceof RepositoryError) throw error;
      throw databaseFailure('task revocation', error);
    }
  }

  /** Narrow system-scope discovery: return only tenant routing IDs. */
  async findPurgeTenantIds(cutoff: Date, limit: number): Promise<string[]> {
    if (!Number.isInteger(limit) || limit <= 0 || limit > 10_000) {
      throw new RepositoryError('Executor session token cleanup limit is invalid');
    }
    try {
      const result = await executeRaw(
        this.db,
        sql`
          SELECT tenant_id
          FROM ${executorSessionTokenAuthorities}
          WHERE expires_at < ${sql.param(cutoff, executorSessionTokenAuthorities.expires_at)}
             OR (
               revoked_at IS NOT NULL
               AND revoked_at < ${sql.param(cutoff, executorSessionTokenAuthorities.revoked_at)}
             )
          GROUP BY tenant_id
          ORDER BY tenant_id
          LIMIT ${limit}
        `
      );
      return rowsOf(result).map((row) => {
        if (typeof row.tenant_id !== 'string' || !row.tenant_id) {
          throw new RepositoryError('Executor token cleanup discovered invalid tenant routing');
        }
        return row.tenant_id;
      });
    } catch (error) {
      if (error instanceof RepositoryError) throw error;
      throw databaseFailure('retention discovery', error);
    }
  }

  /**
   * Delete authority tombstones after their retention window in one tenant.
   * Absence remains fail-closed: a deleted expired/revoked row can never
   * authenticate again.
   */
  async purgeRetained(tenantId: string, cutoff: Date): Promise<number> {
    try {
      const result = await executeRaw(
        this.db,
        sql`
          WITH purged AS (
            DELETE FROM ${executorSessionTokenAuthorities}
            WHERE tenant_id = ${tenantId}
              AND (
                expires_at < ${sql.param(cutoff, executorSessionTokenAuthorities.expires_at)}
                OR (
                  revoked_at IS NOT NULL
                  AND revoked_at < ${sql.param(cutoff, executorSessionTokenAuthorities.revoked_at)}
                )
              )
            RETURNING 1
          )
          SELECT count(*) AS count FROM purged
        `
      );
      return Number(rowsOf(result)[0]?.count ?? 0);
    } catch (error) {
      throw databaseFailure('retention cleanup', error);
    }
  }
}
