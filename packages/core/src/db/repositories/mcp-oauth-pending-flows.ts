/**
 * PostgreSQL authority for browser-based MCP OAuth attempts.
 *
 * Callers derive stateHash from the high-entropy OAuth state and establish
 * trusted tenant/user/server identity before entering this repository. Raw
 * state, provider authorization codes, and OAuth tokens are never accepted by
 * this layer. Secret exchange material is an opaque sealed envelope.
 */

import type {
  MCPOAuthAttemptID,
  MCPOAuthMode,
  MCPOAuthPendingFlowStatus,
  MCPServerID,
  UserID,
} from '@agor/core/types';
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
// This repository is intentionally PostgreSQL-only. Import the concrete table
// rather than the dialect union so tenant_id remains part of the static type.
import { mcpOauthPendingFlows } from '../schema.postgres';
import { getCurrentTenantDatabaseScope } from '../tenant-context';
import { RepositoryError } from './base';

const SHA256_HEX = /^[a-f0-9]{64}$/;
const SAFE_FAILURE_CODE = /^[a-z0-9_]{1,64}$/;

export interface MCPOAuthPendingFlowCreate {
  tenantId: string;
  attemptId: MCPOAuthAttemptID;
  stateHash: string;
  userId: UserID;
  mcpServerId: MCPServerID;
  oauthMode: MCPOAuthMode;
  subjectUserId: UserID | null;
  grantGeneration: number;
  configFingerprintVersion: number;
  configFingerprint: string;
  envelopeVersion: number;
  sealedMaterial: string;
  /** Relative lifetime applied against the PostgreSQL clock at insert time. */
  ttlMs: number;
}

export type MCPOAuthGrantSubject = Pick<
  MCPOAuthPendingFlowCreate,
  'tenantId' | 'mcpServerId' | 'oauthMode' | 'subjectUserId'
>;

export interface MCPOAuthPendingFlowRecord {
  tenantId: string;
  attemptId: MCPOAuthAttemptID;
  stateHash: string;
  userId: UserID;
  mcpServerId: MCPServerID;
  oauthMode: MCPOAuthMode;
  subjectUserId: UserID | null;
  grantGeneration: number;
  configFingerprintVersion: number;
  configFingerprint: string;
  envelopeVersion: number;
  isCurrent: boolean;
  status: MCPOAuthPendingFlowStatus;
  sealedMaterial: string | null;
  exchangeClaimId: string | null;
  failureCode: string | null;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date;
  exchangeStartedAt: Date | null;
  finishedAt: Date | null;
}

export type MCPOAuthPendingFlowClaimResult =
  | { outcome: 'claimed'; flow: MCPOAuthPendingFlowRecord }
  | { outcome: 'not_claimed'; flow: MCPOAuthPendingFlowRecord | null };

function rowsOf(result: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(result)) return result as Array<Record<string, unknown>>;
  const rows = (result as { rows?: unknown[] } | undefined)?.rows;
  return Array.isArray(rows) ? (rows as Array<Record<string, unknown>>) : [];
}

function asDate(value: unknown, field: string): Date {
  const date = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(date.getTime())) {
    throw new RepositoryError(`MCP OAuth pending flow has invalid ${field}`);
  }
  return date;
}

function asNullableDate(value: unknown, field: string): Date | null {
  return value == null ? null : asDate(value, field);
}

function mapRow(row: Record<string, unknown>): MCPOAuthPendingFlowRecord {
  const status = row.status;
  if (
    typeof row.tenant_id !== 'string' ||
    typeof row.attempt_id !== 'string' ||
    typeof row.state_hash !== 'string' ||
    typeof row.user_id !== 'string' ||
    typeof row.mcp_server_id !== 'string' ||
    (row.oauth_mode !== 'per_user' && row.oauth_mode !== 'shared') ||
    (row.subject_user_id !== null && typeof row.subject_user_id !== 'string') ||
    !Number.isSafeInteger(Number(row.grant_generation)) ||
    !Number.isSafeInteger(Number(row.config_fingerprint_version)) ||
    typeof row.config_fingerprint !== 'string' ||
    !SHA256_HEX.test(row.config_fingerprint) ||
    !Number.isSafeInteger(Number(row.envelope_version)) ||
    typeof row.is_current !== 'boolean' ||
    !['pending', 'exchanging', 'succeeded', 'failed', 'ambiguous', 'expired'].includes(
      String(status)
    ) ||
    (row.sealed_material !== null && typeof row.sealed_material !== 'string') ||
    (row.exchange_claim_id !== null && typeof row.exchange_claim_id !== 'string') ||
    (row.failure_code !== null && typeof row.failure_code !== 'string')
  ) {
    throw new RepositoryError('MCP OAuth pending flow row is invalid');
  }
  return {
    tenantId: row.tenant_id,
    attemptId: row.attempt_id as MCPOAuthAttemptID,
    stateHash: row.state_hash,
    userId: row.user_id as UserID,
    mcpServerId: row.mcp_server_id as MCPServerID,
    oauthMode: row.oauth_mode,
    subjectUserId: row.subject_user_id as UserID | null,
    grantGeneration: Number(row.grant_generation),
    configFingerprintVersion: Number(row.config_fingerprint_version),
    configFingerprint: row.config_fingerprint,
    envelopeVersion: Number(row.envelope_version),
    isCurrent: row.is_current,
    status: status as MCPOAuthPendingFlowStatus,
    sealedMaterial: row.sealed_material,
    exchangeClaimId: row.exchange_claim_id,
    failureCode: row.failure_code,
    createdAt: asDate(row.created_at, 'created_at'),
    updatedAt: asDate(row.updated_at, 'updated_at'),
    expiresAt: asDate(row.expires_at, 'expires_at'),
    exchangeStartedAt: asNullableDate(row.exchange_started_at, 'exchange_started_at'),
    finishedAt: asNullableDate(row.finished_at, 'finished_at'),
  };
}

function assertStateHash(stateHash: string): void {
  if (!SHA256_HEX.test(stateHash)) {
    throw new RepositoryError('MCP OAuth state fingerprint is invalid');
  }
}

function assertFailureCode(failureCode: string): void {
  if (!SAFE_FAILURE_CODE.test(failureCode)) {
    throw new RepositoryError('MCP OAuth failure code is invalid');
  }
}

function databaseFailure(operation: string, error: unknown): RepositoryError {
  return new RepositoryError(`MCP OAuth pending flow ${operation} failed`, sanitizeDbError(error));
}

/** PostgreSQL-only pending-flow repository. */
export class MCPOAuthPendingFlowRepository {
  constructor(private readonly db: Database) {
    if (!isPostgresDatabase(db)) {
      throw new RepositoryError('MCP OAuth pending flow authority requires PostgreSQL');
    }
  }

  private async lockGrantSubject(subject: MCPOAuthGrantSubject): Promise<void> {
    const scope = getCurrentTenantDatabaseScope();
    if (scope?.kind !== 'tenant' || scope.db !== this.db || scope.tenantId !== subject.tenantId) {
      throw new RepositoryError('MCP OAuth grant-subject lock requires its tenant transaction');
    }
    await executeRaw(
      this.db,
      sql`SELECT pg_advisory_xact_lock(
        hashtextextended(
          ${[
            subject.tenantId,
            subject.mcpServerId,
            subject.oauthMode,
            subject.subjectUserId ?? '<shared>',
          ].join('\u001f')},
          0
        )
      )`
    );
  }

  /**
   * Serialize a grant subject before allocating its deployment-wide attempt
   * generation. The caller's tenant transaction retains this xact lock while
   * it seals exchange material and inserts the attempt through create().
   */
  async allocateGrantGeneration(subject: MCPOAuthGrantSubject): Promise<number> {
    try {
      await this.lockGrantSubject(subject);
      const result = await executeRaw(
        this.db,
        sql`SELECT nextval('mcp_oauth_grant_generation_seq') AS generation`
      );
      const generation = Number(rowsOf(result)[0]?.generation);
      if (!Number.isSafeInteger(generation) || generation <= 0) {
        throw new RepositoryError('MCP OAuth grant generation is invalid');
      }
      return generation;
    } catch (error) {
      if (error instanceof RepositoryError) throw error;
      throw databaseFailure('generation allocation', error);
    }
  }

  async create(input: MCPOAuthPendingFlowCreate): Promise<void> {
    assertStateHash(input.stateHash);
    if (
      !input.tenantId ||
      !input.attemptId ||
      !input.userId ||
      !input.mcpServerId ||
      !input.sealedMaterial ||
      !SHA256_HEX.test(input.configFingerprint) ||
      !Number.isSafeInteger(input.grantGeneration) ||
      input.grantGeneration <= 0 ||
      input.configFingerprintVersion !== 1 ||
      input.envelopeVersion !== 1 ||
      (input.oauthMode === 'per_user' && input.subjectUserId !== input.userId) ||
      (input.oauthMode === 'shared' && input.subjectUserId !== null)
    ) {
      throw new RepositoryError('MCP OAuth pending flow binding is incomplete');
    }
    if (!Number.isSafeInteger(input.ttlMs) || input.ttlMs <= 0) {
      throw new RepositoryError('MCP OAuth pending flow lifetime is invalid');
    }
    try {
      // Serialize the update+insert pair per grant subject. Partial unique
      // indexes remain the final invariant; this lock makes simultaneous
      // starts deterministic rather than returning a uniqueness race.
      await this.lockGrantSubject(input);
      // Latest attempt wins for a grant subject. An older exchange may already
      // have consumed a provider code, so it becomes ambiguous rather than
      // replayable. No terminal row retains sealed material.
      await executeRaw(
        this.db,
        sql`
          UPDATE ${mcpOauthPendingFlows}
          SET status = CASE
                WHEN status = 'exchanging' THEN 'ambiguous'
                WHEN status = 'pending' THEN 'failed'
                ELSE status
              END,
              failure_code = CASE
                WHEN status IN ('pending', 'exchanging') THEN 'superseded_by_newer_attempt'
                ELSE failure_code
              END,
              is_current = false,
              sealed_material = NULL,
              updated_at = CURRENT_TIMESTAMP,
              finished_at = CASE
                WHEN status IN ('pending', 'exchanging') THEN CURRENT_TIMESTAMP
                ELSE finished_at
              END
          WHERE tenant_id = ${input.tenantId}
            AND mcp_server_id = ${input.mcpServerId}
            AND oauth_mode = ${input.oauthMode}
            AND subject_user_id IS NOT DISTINCT FROM ${input.subjectUserId}
            AND is_current = true
        `
      );
      await insert(this.db, mcpOauthPendingFlows)
        .values({
          tenant_id: input.tenantId,
          attempt_id: input.attemptId,
          state_hash: input.stateHash,
          user_id: input.userId,
          mcp_server_id: input.mcpServerId,
          oauth_mode: input.oauthMode,
          subject_user_id: input.subjectUserId,
          grant_generation: input.grantGeneration,
          config_fingerprint_version: input.configFingerprintVersion,
          config_fingerprint: input.configFingerprint,
          envelope_version: input.envelopeVersion,
          is_current: true,
          status: 'pending',
          sealed_material: input.sealedMaterial,
          // Capability expiry must not depend on whichever daemon accepted the
          // start request. Every later claim/maintenance comparison also uses
          // CURRENT_TIMESTAMP, so creation uses the same PostgreSQL clock.
          created_at: sql`CURRENT_TIMESTAMP`,
          updated_at: sql`CURRENT_TIMESTAMP`,
          expires_at: sql`CURRENT_TIMESTAMP + (${input.ttlMs} * INTERVAL '1 millisecond')`,
        })
        .run();
    } catch (error) {
      throw databaseFailure('creation', error);
    }
  }

  /** Claim from an unauthenticated callback running under mcp_oauth_callback. */
  async claimForCallback(
    stateHash: string,
    claimId: string
  ): Promise<MCPOAuthPendingFlowClaimResult> {
    await this.bindCallbackStateFingerprint(stateHash);
    return this.claim(stateHash, claimId);
  }

  /** Claim from an authenticated manual-complete request in its tenant scope. */
  async claimForUser(
    tenantId: string,
    userId: UserID,
    stateHash: string,
    claimId: string
  ): Promise<MCPOAuthPendingFlowClaimResult> {
    return this.claim(stateHash, claimId, { tenantId, userId });
  }

  private async claim(
    stateHash: string,
    claimId: string,
    expected?: { tenantId: string; userId: UserID }
  ): Promise<MCPOAuthPendingFlowClaimResult> {
    assertStateHash(stateHash);
    if (!claimId) throw new RepositoryError('MCP OAuth exchange claim is missing');
    const tenantPredicate = expected ? sql`AND tenant_id = ${expected.tenantId}` : sql``;
    const userPredicate = expected ? sql`AND user_id = ${expected.userId}` : sql``;
    try {
      // Preserve an explicit expired terminal state rather than making an
      // expired capability indistinguishable from a random state value.
      await executeRaw(
        this.db,
        sql`
          UPDATE ${mcpOauthPendingFlows}
          SET status = 'expired',
              failure_code = 'authorization_timed_out',
              sealed_material = NULL,
              updated_at = CURRENT_TIMESTAMP,
              finished_at = CURRENT_TIMESTAMP
          WHERE state_hash = ${stateHash}
            ${tenantPredicate}
            ${userPredicate}
            AND status = 'pending'
            AND expires_at <= CURRENT_TIMESTAMP
        `
      );

      const claimed = await executeRaw(
        this.db,
        sql`
          UPDATE ${mcpOauthPendingFlows}
          SET status = 'exchanging',
              exchange_claim_id = ${claimId},
              exchange_started_at = CURRENT_TIMESTAMP,
              updated_at = CURRENT_TIMESTAMP
          WHERE state_hash = ${stateHash}
            ${tenantPredicate}
            ${userPredicate}
            AND status = 'pending'
            AND expires_at > CURRENT_TIMESTAMP
            AND is_current = true
          RETURNING *
        `
      );
      const claimedRow = rowsOf(claimed)[0];
      if (claimedRow) return { outcome: 'claimed', flow: mapRow(claimedRow) };

      const observed = await select(this.db)
        .from(mcpOauthPendingFlows)
        .where(
          expected
            ? and(
                eq(mcpOauthPendingFlows.state_hash, stateHash),
                eq(mcpOauthPendingFlows.tenant_id, expected.tenantId),
                eq(mcpOauthPendingFlows.user_id, expected.userId)
              )
            : eq(mcpOauthPendingFlows.state_hash, stateHash)
        )
        .one();
      return {
        outcome: 'not_claimed',
        flow: observed ? mapRow(observed as unknown as Record<string, unknown>) : null,
      };
    } catch (error) {
      if (error instanceof RepositoryError) throw error;
      throw databaseFailure('claim', error);
    }
  }

  /** Provider returned an authorization error before an exchange was attempted. */
  async failPendingForCallback(stateHash: string, failureCode: string): Promise<boolean> {
    assertStateHash(stateHash);
    assertFailureCode(failureCode);
    try {
      await this.bindCallbackStateFingerprint(stateHash);
      const result = await executeRaw(
        this.db,
        sql`
          UPDATE ${mcpOauthPendingFlows}
          SET status = CASE WHEN expires_at <= CURRENT_TIMESTAMP THEN 'expired' ELSE 'failed' END,
              failure_code = CASE
                WHEN expires_at <= CURRENT_TIMESTAMP THEN 'authorization_timed_out'
                ELSE ${failureCode}
              END,
              sealed_material = NULL,
              updated_at = CURRENT_TIMESTAMP,
              finished_at = CURRENT_TIMESTAMP
          WHERE state_hash = ${stateHash}
            AND status = 'pending'
          RETURNING attempt_id
        `
      );
      return rowsOf(result).length > 0;
    } catch (error) {
      throw databaseFailure('authorization failure transition', error);
    }
  }

  /** Bind callback RLS to this exact one-time fingerprint for the transaction. */
  private async bindCallbackStateFingerprint(stateHash: string): Promise<void> {
    assertStateHash(stateHash);
    try {
      await executeRaw(
        this.db,
        sql`SELECT set_config('agor.oauth_state_hash', ${stateHash}, true)`
      );
    } catch (error) {
      throw databaseFailure('callback binding', error);
    }
  }

  async getForUser(
    tenantId: string,
    userId: UserID,
    attemptId: MCPOAuthAttemptID
  ): Promise<MCPOAuthPendingFlowRecord | null> {
    try {
      const row = await select(this.db)
        .from(mcpOauthPendingFlows)
        .where(
          and(
            eq(mcpOauthPendingFlows.tenant_id, tenantId),
            eq(mcpOauthPendingFlows.user_id, userId),
            eq(mcpOauthPendingFlows.attempt_id, attemptId)
          )
        )
        .one();
      return row ? mapRow(row as unknown as Record<string, unknown>) : null;
    } catch (error) {
      if (error instanceof RepositoryError) throw error;
      throw databaseFailure('status read', error);
    }
  }

  async finish(
    tenantId: string,
    attemptId: MCPOAuthAttemptID,
    claimId: string,
    status: 'succeeded' | 'failed' | 'ambiguous',
    failureCode?: string
  ): Promise<boolean> {
    if (status === 'succeeded' && failureCode) {
      throw new RepositoryError('Successful MCP OAuth attempt cannot carry a failure code');
    }
    if (status !== 'succeeded' && !failureCode) {
      throw new RepositoryError('Terminal MCP OAuth failure requires a failure code');
    }
    if (failureCode) assertFailureCode(failureCode);
    try {
      const result = await executeRaw(
        this.db,
        sql`
          UPDATE ${mcpOauthPendingFlows}
          SET status = ${status},
              failure_code = ${failureCode ?? null},
              sealed_material = NULL,
              updated_at = CURRENT_TIMESTAMP,
              finished_at = CURRENT_TIMESTAMP
          WHERE tenant_id = ${tenantId}
            AND attempt_id = ${attemptId}
            AND status = 'exchanging'
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

  /** Invalidate every active attempt after an auth-relevant server mutation. */
  async invalidateForServer(tenantId: string, serverId: MCPServerID): Promise<number> {
    try {
      const result = await update(this.db, mcpOauthPendingFlows)
        .set({
          status: sql`CASE WHEN status = 'exchanging' THEN 'ambiguous' ELSE 'failed' END`,
          failure_code: 'server_configuration_changed',
          is_current: false,
          sealed_material: null,
          updated_at: sql`CURRENT_TIMESTAMP`,
          finished_at: sql`CURRENT_TIMESTAMP`,
        })
        .where(
          sql`tenant_id = ${tenantId}
              AND mcp_server_id = ${serverId}
              AND status IN ('pending', 'exchanging')`
        )
        .run();
      return result.rowsAffected;
    } catch (error) {
      throw databaseFailure('server invalidation', error);
    }
  }

  /**
   * Fleet-safe cleanup. Pending attempts age to expired; an abandoned exchange
   * ages to ambiguous because the daemon cannot know whether the provider
   * consumed the single-use authorization code. Terminal tombstones are kept
   * for 24 hours so UI/status retries can explain the outcome safely.
   */
  async maintain(): Promise<{ expired: number; ambiguous: number; purged: number }> {
    try {
      // Do not use RETURNING here. The maintenance SELECT policy admits due
      // inputs and the expired/ambiguous outputs created at this transaction's
      // exact database time; mutation metadata gives us counts without making
      // those cross-tenant rows part of the application result.
      const expired = await update(this.db, mcpOauthPendingFlows)
        .set({
          status: 'expired',
          failure_code: 'authorization_timed_out',
          sealed_material: null,
          updated_at: sql`CURRENT_TIMESTAMP`,
          finished_at: sql`CURRENT_TIMESTAMP`,
        })
        .where(sql`status = 'pending' AND expires_at <= CURRENT_TIMESTAMP`)
        .run();
      const ambiguous = await update(this.db, mcpOauthPendingFlows)
        .set({
          status: 'ambiguous',
          failure_code: 'exchange_owner_lost',
          sealed_material: null,
          updated_at: sql`CURRENT_TIMESTAMP`,
          finished_at: sql`CURRENT_TIMESTAMP`,
        })
        .where(
          sql`status = 'exchanging'
              AND exchange_started_at <= CURRENT_TIMESTAMP - INTERVAL '2 minutes'`
        )
        .run();
      const purged = await deleteFrom(this.db, mcpOauthPendingFlows)
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
