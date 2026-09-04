/**
 * PostgreSQL authority for Claude subscription OAuth sign-in attempts.
 *
 * Callers derive stateHash from the high-entropy OAuth state and establish
 * trusted tenant/user identity before entering this repository. Raw state,
 * the pasted authorization code, and the exchanged tokens are never accepted by
 * this layer. PKCE material is an opaque sealed envelope.
 *
 * Mirrors `mcp-oauth-pending-flows.ts`. The difference is the trigger: Claude
 * has no provider callback, so every transition arrives inside the initiating
 * user's authenticated tenant scope and there is no callback capability.
 */

import type { ClaudeOAuthAttemptID, ClaudeOAuthAttemptStatus, UserID } from '@agor/core/types';
import { and, eq, sql } from 'drizzle-orm';
import type { Database } from '../client';
import {
  deleteFrom,
  executeRaw,
  insert,
  isPostgresDatabase,
  select,
  update,
} from '../database-wrapper';
import { sanitizeDbError } from '../sanitize-error';
// Intentionally PostgreSQL-only: import the concrete table so tenant_id stays
// part of the static type.
import { claudeOauthAttempts } from '../schema.postgres';
import { assertAuthorityFailureCode, lockTenantAuthoritySubject } from './authority-primitives';
import { RepositoryError } from './base';

const SHA256_HEX = /^[a-f0-9]{64}$/;

export interface ClaudeOAuthAttemptCreate {
  tenantId: string;
  attemptId: ClaudeOAuthAttemptID;
  stateHash: string;
  userId: UserID;
  attemptGeneration: number;
  envelopeVersion: number;
  sealedMaterial: string;
  /** Relative lifetime applied against the PostgreSQL clock at insert time. */
  ttlMs: number;
}

export interface ClaudeOAuthAttemptRecord {
  tenantId: string;
  attemptId: ClaudeOAuthAttemptID;
  stateHash: string;
  userId: UserID;
  attemptGeneration: number;
  envelopeVersion: number;
  isCurrent: boolean;
  status: ClaudeOAuthAttemptStatus;
  sealedMaterial: string | null;
  exchangeClaimId: string | null;
  failureCode: string | null;
  subscriptionType: string | null;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date;
  exchangeStartedAt: Date | null;
  finishedAt: Date | null;
}

export type ClaudeOAuthAttemptClaimResult =
  | { outcome: 'claimed'; attempt: ClaudeOAuthAttemptRecord }
  | { outcome: 'not_claimed'; attempt: ClaudeOAuthAttemptRecord | null };

function rowsOf(result: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(result)) return result as Array<Record<string, unknown>>;
  const rows = (result as { rows?: unknown[] } | undefined)?.rows;
  return Array.isArray(rows) ? (rows as Array<Record<string, unknown>>) : [];
}

function asDate(value: unknown, field: string): Date {
  const date = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(date.getTime())) {
    throw new RepositoryError(`Claude OAuth attempt has invalid ${field}`);
  }
  return date;
}

function asNullableDate(value: unknown, field: string): Date | null {
  return value == null ? null : asDate(value, field);
}

function mapRow(row: Record<string, unknown>): ClaudeOAuthAttemptRecord {
  const status = row.status;
  if (
    typeof row.tenant_id !== 'string' ||
    typeof row.attempt_id !== 'string' ||
    typeof row.state_hash !== 'string' ||
    typeof row.user_id !== 'string' ||
    !Number.isSafeInteger(Number(row.attempt_generation)) ||
    !Number.isSafeInteger(Number(row.envelope_version)) ||
    typeof row.is_current !== 'boolean' ||
    ![
      'pending',
      'exchanging',
      'persisting',
      'succeeded',
      'failed',
      'ambiguous',
      'expired',
    ].includes(String(status)) ||
    (row.sealed_material !== null && typeof row.sealed_material !== 'string') ||
    (row.exchange_claim_id !== null && typeof row.exchange_claim_id !== 'string') ||
    (row.failure_code !== null && typeof row.failure_code !== 'string') ||
    (row.subscription_type !== null && typeof row.subscription_type !== 'string')
  ) {
    throw new RepositoryError('Claude OAuth attempt row is invalid');
  }
  return {
    tenantId: row.tenant_id,
    attemptId: row.attempt_id as ClaudeOAuthAttemptID,
    stateHash: row.state_hash,
    userId: row.user_id as UserID,
    attemptGeneration: Number(row.attempt_generation),
    envelopeVersion: Number(row.envelope_version),
    isCurrent: row.is_current,
    status: status as ClaudeOAuthAttemptStatus,
    sealedMaterial: row.sealed_material,
    exchangeClaimId: row.exchange_claim_id,
    failureCode: row.failure_code,
    subscriptionType: row.subscription_type,
    createdAt: asDate(row.created_at, 'created_at'),
    updatedAt: asDate(row.updated_at, 'updated_at'),
    expiresAt: asDate(row.expires_at, 'expires_at'),
    exchangeStartedAt: asNullableDate(row.exchange_started_at, 'exchange_started_at'),
    finishedAt: asNullableDate(row.finished_at, 'finished_at'),
  };
}

function assertStateHash(stateHash: string): void {
  if (!SHA256_HEX.test(stateHash)) {
    throw new RepositoryError('Claude OAuth state fingerprint is invalid');
  }
}

function assertFailureCode(failureCode: string): void {
  assertAuthorityFailureCode(failureCode, 'Claude OAuth');
}

function databaseFailure(operation: string, error: unknown): RepositoryError {
  return new RepositoryError(`Claude OAuth attempt ${operation} failed`, sanitizeDbError(error));
}

/** PostgreSQL-only Claude OAuth attempt repository. */
export class ClaudeOAuthAttemptRepository {
  constructor(private readonly db: Database) {
    if (!isPostgresDatabase(db)) {
      throw new RepositoryError('Claude OAuth attempt authority requires PostgreSQL');
    }
  }

  async lockUser(tenantId: string, userId: UserID): Promise<void> {
    // Deliberately the exact same namespace/key as Codex. Cross-provider
    // mutations take one user authority before either service enters its
    // users-service role lock, avoiding lock-order inversions.
    await lockTenantAuthoritySubject(this.db, tenantId, `${tenantId}\u001f${userId}`);
  }

  /**
   * Serialize one user's attempts before allocating the deployment-wide
   * generation. The caller's tenant transaction retains this xact lock while it
   * seals material and inserts through create(), so a lower generation can never
   * insert after and supersede a higher one.
   */
  async allocateAttemptGeneration(tenantId: string, userId: UserID): Promise<number> {
    try {
      await this.lockUser(tenantId, userId);
      const result = await executeRaw(
        this.db,
        sql`SELECT nextval('claude_oauth_attempt_generation_seq') AS generation`
      );
      const generation = Number(rowsOf(result)[0]?.generation);
      if (!Number.isSafeInteger(generation) || generation <= 0) {
        throw new RepositoryError('Claude OAuth attempt generation is invalid');
      }
      return generation;
    } catch (error) {
      if (error instanceof RepositoryError) throw error;
      throw databaseFailure('generation allocation', error);
    }
  }

  async create(input: ClaudeOAuthAttemptCreate): Promise<void> {
    assertStateHash(input.stateHash);
    if (
      !input.tenantId ||
      !input.attemptId ||
      !input.userId ||
      !input.sealedMaterial ||
      !Number.isSafeInteger(input.attemptGeneration) ||
      input.attemptGeneration <= 0 ||
      input.envelopeVersion !== 1
    ) {
      throw new RepositoryError('Claude OAuth attempt binding is incomplete');
    }
    if (!Number.isSafeInteger(input.ttlMs) || input.ttlMs <= 0) {
      throw new RepositoryError('Claude OAuth attempt lifetime is invalid');
    }
    try {
      // Serialize the supersede+insert pair per user. The partial unique index
      // on (tenant_id, user_id) WHERE is_current remains the final invariant;
      // this lock makes simultaneous starts deterministic instead of surfacing
      // a uniqueness race.
      await this.lockUser(input.tenantId, input.userId);
      // Latest attempt wins. An older exchange may already have POSTed the
      // one-time code to Anthropic, so it becomes ambiguous rather than
      // replayable. No terminal row retains sealed material.
      await executeRaw(
        this.db,
        sql`
          UPDATE ${claudeOauthAttempts}
          SET status = CASE
                WHEN status IN ('exchanging', 'persisting') THEN 'ambiguous'
                WHEN status = 'pending' THEN 'failed'
                ELSE status
              END,
              failure_code = CASE
                WHEN status IN ('pending', 'exchanging', 'persisting') THEN 'superseded_by_newer_attempt'
                ELSE failure_code
              END,
              is_current = false,
              sealed_material = NULL,
              updated_at = CURRENT_TIMESTAMP,
              finished_at = CASE
                WHEN status IN ('pending', 'exchanging', 'persisting') THEN CURRENT_TIMESTAMP
                ELSE finished_at
              END
          WHERE tenant_id = ${input.tenantId}
            AND user_id = ${input.userId}
            AND is_current = true
        `
      );
      await insert(this.db, claudeOauthAttempts)
        .values({
          tenant_id: input.tenantId,
          attempt_id: input.attemptId,
          state_hash: input.stateHash,
          user_id: input.userId,
          attempt_generation: input.attemptGeneration,
          envelope_version: input.envelopeVersion,
          is_current: true,
          status: 'pending',
          sealed_material: input.sealedMaterial,
          // Freshness must not depend on whichever replica accepted the start
          // request. Every later comparison also uses CURRENT_TIMESTAMP.
          created_at: sql`CURRENT_TIMESTAMP`,
          updated_at: sql`CURRENT_TIMESTAMP`,
          expires_at: sql`CURRENT_TIMESTAMP + (${input.ttlMs} * INTERVAL '1 millisecond')`,
        })
        .run();
    } catch (error) {
      throw databaseFailure('creation', error);
    }
  }

  /**
   * One-shot exchange claim. Exactly one replica can move a live attempt from
   * `pending` to `exchanging`, so a code pasted twice (or raced across
   * replicas) is exchanged at most once.
   */
  async claimForExchange(input: {
    tenantId: string;
    userId: UserID;
    attemptId: ClaudeOAuthAttemptID;
    stateHash: string;
    claimId: string;
  }): Promise<ClaudeOAuthAttemptClaimResult> {
    assertStateHash(input.stateHash);
    if (!input.claimId) throw new RepositoryError('Claude OAuth exchange claim is missing');
    try {
      // Record an explicit expiry rather than letting a timed-out attempt look
      // indistinguishable from an unknown one.
      await executeRaw(
        this.db,
        sql`
          UPDATE ${claudeOauthAttempts}
          SET status = 'expired',
              failure_code = 'authorization_timed_out',
              sealed_material = NULL,
              updated_at = CURRENT_TIMESTAMP,
              finished_at = CURRENT_TIMESTAMP
          WHERE tenant_id = ${input.tenantId}
            AND user_id = ${input.userId}
            AND attempt_id = ${input.attemptId}
            AND status = 'pending'
            AND expires_at <= CURRENT_TIMESTAMP
        `
      );

      const claimed = await executeRaw(
        this.db,
        sql`
          UPDATE ${claudeOauthAttempts}
          SET status = 'exchanging',
              exchange_claim_id = ${input.claimId},
              exchange_started_at = CURRENT_TIMESTAMP,
              updated_at = CURRENT_TIMESTAMP
          WHERE tenant_id = ${input.tenantId}
            AND user_id = ${input.userId}
            AND attempt_id = ${input.attemptId}
            AND state_hash = ${input.stateHash}
            AND status = 'pending'
            AND expires_at > CURRENT_TIMESTAMP
            AND is_current = true
          RETURNING *
        `
      );
      const claimedRow = rowsOf(claimed)[0];
      if (claimedRow) return { outcome: 'claimed', attempt: mapRow(claimedRow) };

      return {
        outcome: 'not_claimed',
        attempt: await this.getForUser(input.tenantId, input.userId, input.attemptId),
      };
    } catch (error) {
      if (error instanceof RepositoryError) throw error;
      throw databaseFailure('claim', error);
    }
  }

  /**
   * Re-read a claim that must still be live. Called immediately before the
   * credential write AND again before the user-method mutation, because a
   * logout or a replacement attempt can land between those two steps.
   */
  async readLiveClaim(
    tenantId: string,
    attemptId: ClaudeOAuthAttemptID,
    claimId: string
  ): Promise<ClaudeOAuthAttemptRecord | null> {
    try {
      const row = await select(this.db)
        .from(claudeOauthAttempts)
        .where(
          and(
            eq(claudeOauthAttempts.tenant_id, tenantId),
            eq(claudeOauthAttempts.attempt_id, attemptId),
            eq(claudeOauthAttempts.exchange_claim_id, claimId),
            eq(claudeOauthAttempts.status, 'exchanging'),
            eq(claudeOauthAttempts.is_current, true)
          )
        )
        .one();
      return row ? mapRow(row as unknown as Record<string, unknown>) : null;
    } catch (error) {
      if (error instanceof RepositoryError) throw error;
      throw databaseFailure('claim revalidation', error);
    }
  }

  async markPersisting(record: ClaudeOAuthAttemptRecord): Promise<boolean> {
    if (!record.exchangeClaimId) return false;
    try {
      const result = await executeRaw(
        this.db,
        sql`UPDATE ${claudeOauthAttempts}
            SET status = 'persisting', updated_at = CURRENT_TIMESTAMP
            WHERE tenant_id = ${record.tenantId}
              AND user_id = ${record.userId}
              AND attempt_id = ${record.attemptId}
              AND attempt_generation = ${record.attemptGeneration}
              AND exchange_claim_id = ${record.exchangeClaimId}
              AND status = 'exchanging'
              AND is_current = true
            RETURNING attempt_id`
      );
      return rowsOf(result).length > 0;
    } catch (error) {
      throw databaseFailure('persisting transition', error);
    }
  }

  async getForUser(
    tenantId: string,
    userId: UserID,
    attemptId: ClaudeOAuthAttemptID
  ): Promise<ClaudeOAuthAttemptRecord | null> {
    try {
      const row = await select(this.db)
        .from(claudeOauthAttempts)
        .where(
          and(
            eq(claudeOauthAttempts.tenant_id, tenantId),
            eq(claudeOauthAttempts.user_id, userId),
            eq(claudeOauthAttempts.attempt_id, attemptId)
          )
        )
        .one();
      return row ? mapRow(row as unknown as Record<string, unknown>) : null;
    } catch (error) {
      if (error instanceof RepositoryError) throw error;
      throw databaseFailure('status read', error);
    }
  }

  /** The live attempt for a user, used when a client reconnects without an id. */
  async getCurrentForUser(
    tenantId: string,
    userId: UserID
  ): Promise<ClaudeOAuthAttemptRecord | null> {
    try {
      const row = await select(this.db)
        .from(claudeOauthAttempts)
        .where(
          and(
            eq(claudeOauthAttempts.tenant_id, tenantId),
            eq(claudeOauthAttempts.user_id, userId),
            eq(claudeOauthAttempts.is_current, true)
          )
        )
        .one();
      return row ? mapRow(row as unknown as Record<string, unknown>) : null;
    } catch (error) {
      if (error instanceof RepositoryError) throw error;
      throw databaseFailure('current attempt read', error);
    }
  }

  async finish(
    tenantId: string,
    attemptId: ClaudeOAuthAttemptID,
    claimId: string,
    status: 'succeeded' | 'failed' | 'ambiguous',
    options: { failureCode?: string; subscriptionType?: string | null } = {}
  ): Promise<boolean> {
    const { failureCode, subscriptionType } = options;
    if (status === 'succeeded' && failureCode) {
      throw new RepositoryError('Successful Claude OAuth attempt cannot carry a failure code');
    }
    if (status !== 'succeeded' && !failureCode) {
      throw new RepositoryError('Terminal Claude OAuth failure requires a failure code');
    }
    if (failureCode) assertFailureCode(failureCode);
    try {
      const result = await executeRaw(
        this.db,
        sql`
          UPDATE ${claudeOauthAttempts}
          SET status = ${status},
              failure_code = ${failureCode ?? null},
              subscription_type = ${subscriptionType ?? null},
              sealed_material = NULL,
              updated_at = CURRENT_TIMESTAMP,
              finished_at = CURRENT_TIMESTAMP
          WHERE tenant_id = ${tenantId}
            AND attempt_id = ${attemptId}
            AND status = ${status === 'succeeded' ? 'persisting' : 'exchanging'}
            AND exchange_claim_id = ${claimId}
            AND is_current = true
          RETURNING attempt_id
        `
      );
      return rowsOf(result).length > 0;
    } catch (error) {
      throw databaseFailure(`${status} transition`, error);
    }
  }

  /**
   * Invalidate every live attempt for a user — logout, or any other event that
   * makes an in-flight sign-in meaningless. An in-flight exchange becomes
   * ambiguous because the daemon cannot know whether Anthropic consumed the
   * code. This is the durable replacement for the process-local cancel flag.
   */
  async invalidateForUser(tenantId: string, userId: UserID, failureCode: string): Promise<number> {
    assertFailureCode(failureCode);
    try {
      await this.lockUser(tenantId, userId);
      const result = await update(this.db, claudeOauthAttempts)
        .set({
          status: sql`CASE
            WHEN status IN ('exchanging', 'persisting') THEN 'ambiguous'
            WHEN status = 'pending' THEN 'failed'
            ELSE status
          END`,
          failure_code: sql`CASE
            WHEN status IN ('pending', 'exchanging', 'persisting') THEN ${failureCode}
            ELSE failure_code
          END`,
          is_current: false,
          sealed_material: null,
          updated_at: sql`CURRENT_TIMESTAMP`,
          finished_at: sql`CASE
            WHEN status IN ('pending', 'exchanging', 'persisting') THEN CURRENT_TIMESTAMP
            ELSE finished_at
          END`,
        })
        .where(
          sql`tenant_id = ${tenantId}
              AND user_id = ${userId}
              AND is_current = true`
        )
        .run();
      return result.rowsAffected;
    } catch (error) {
      throw databaseFailure('user invalidation', error);
    }
  }

  /**
   * Fleet-safe cleanup. Pending attempts age to expired; an abandoned exchange
   * ages to ambiguous because the daemon cannot know whether Anthropic consumed
   * the single-use code. Terminal tombstones are kept for 24 hours so status
   * reads can still explain the outcome.
   */
  async maintain(): Promise<{ expired: number; ambiguous: number; purged: number }> {
    try {
      const expired = await update(this.db, claudeOauthAttempts)
        .set({
          status: 'expired',
          failure_code: 'authorization_timed_out',
          sealed_material: null,
          updated_at: sql`CURRENT_TIMESTAMP`,
          finished_at: sql`CURRENT_TIMESTAMP`,
        })
        .where(sql`status = 'pending' AND expires_at <= CURRENT_TIMESTAMP`)
        .run();
      const ambiguous = await update(this.db, claudeOauthAttempts)
        .set({
          status: 'ambiguous',
          failure_code: 'exchange_owner_lost',
          sealed_material: null,
          updated_at: sql`CURRENT_TIMESTAMP`,
          finished_at: sql`CURRENT_TIMESTAMP`,
        })
        .where(
          sql`status IN ('exchanging', 'persisting')
              AND exchange_started_at <= CURRENT_TIMESTAMP - INTERVAL '2 minutes'`
        )
        .run();
      const purged = await deleteFrom(this.db, claudeOauthAttempts)
        .where(
          sql`status IN ('succeeded', 'failed', 'ambiguous', 'expired')
              AND finished_at <= CURRENT_TIMESTAMP - INTERVAL '24 hours'`
        )
        .run();
      return {
        expired: expired.rowsAffected,
        ambiguous: ambiguous.rowsAffected,
        purged: purged.rowsAffected,
      };
    } catch (error) {
      throw databaseFailure('maintenance', error);
    }
  }
}
