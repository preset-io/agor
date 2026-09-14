/** PostgreSQL authority primitives for Codex device-sign-in attempts. */

import type {
  CodexDeviceAuthAttemptID,
  CodexDeviceAuthAttemptStatus,
  UserID,
} from '@agor/core/types';
import { sql } from 'drizzle-orm';
import type { Database } from '../client';
import { executeRaw, isPostgresDatabase, rawRows, rawRowsAffected } from '../database-wrapper';
import { sanitizeDbError } from '../sanitize-error';
import { assertAuthorityFailureCode, lockTenantAuthoritySubject } from './authority-primitives';
import { RepositoryError } from './base';

const STATUSES: readonly CodexDeviceAuthAttemptStatus[] = [
  'starting',
  'pending',
  'exchanging',
  'persisting',
  'succeeded',
  'unavailable',
  'denied',
  'failed',
  'ambiguous',
  'expired',
  'superseded',
  'cancelled',
];

export interface CodexDeviceAuthAttemptRecord {
  tenantId: string;
  attemptId: CodexDeviceAuthAttemptID;
  userId: UserID;
  attemptGeneration: number;
  envelopeVersion: number;
  isCurrent: boolean;
  status: CodexDeviceAuthAttemptStatus;
  sealedMaterial: string | null;
  pollIntervalMs: number | null;
  pollNextAt: Date | null;
  pollClaimId: string | null;
  pollClaimGeneration: number;
  pollLeaseExpiresAt: Date | null;
  exchangeClaimId: string | null;
  failureCode: string | null;
  planType: string | null;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date;
  exchangeStartedAt: Date | null;
  finishedAt: Date | null;
}

function date(value: unknown, field: string): Date {
  const result = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(result.getTime())) throw new RepositoryError(`Invalid ${field}`);
  return result;
}

function nullableDate(value: unknown, field: string): Date | null {
  return value == null ? null : date(value, field);
}

function mapRow(row: Record<string, unknown>): CodexDeviceAuthAttemptRecord {
  const status = String(row.status) as CodexDeviceAuthAttemptStatus;
  const pollIntervalMs = row.poll_interval_ms == null ? null : Number(row.poll_interval_ms);
  const pollClaimGeneration = Number(row.poll_claim_generation);
  if (
    typeof row.tenant_id !== 'string' ||
    typeof row.attempt_id !== 'string' ||
    typeof row.user_id !== 'string' ||
    !Number.isSafeInteger(Number(row.attempt_generation)) ||
    !Number.isSafeInteger(Number(row.envelope_version)) ||
    typeof row.is_current !== 'boolean' ||
    !STATUSES.includes(status) ||
    (pollIntervalMs !== null &&
      (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 2_000)) ||
    !Number.isSafeInteger(pollClaimGeneration) ||
    pollClaimGeneration < 0 ||
    (row.sealed_material != null && typeof row.sealed_material !== 'string') ||
    (row.failure_code != null && typeof row.failure_code !== 'string')
  ) {
    throw new RepositoryError('Codex device auth attempt row is invalid');
  }
  return {
    tenantId: row.tenant_id,
    attemptId: row.attempt_id as CodexDeviceAuthAttemptID,
    userId: row.user_id as UserID,
    attemptGeneration: Number(row.attempt_generation),
    envelopeVersion: Number(row.envelope_version),
    isCurrent: row.is_current,
    status,
    sealedMaterial: row.sealed_material as string | null,
    pollIntervalMs,
    pollNextAt: nullableDate(row.poll_next_at, 'poll_next_at'),
    pollClaimId: (row.poll_claim_id as string | null) ?? null,
    pollClaimGeneration,
    pollLeaseExpiresAt: nullableDate(row.poll_lease_expires_at, 'poll_lease_expires_at'),
    exchangeClaimId: (row.exchange_claim_id as string | null) ?? null,
    failureCode: (row.failure_code as string | null) ?? null,
    planType: (row.plan_type as string | null) ?? null,
    createdAt: date(row.created_at, 'created_at'),
    updatedAt: date(row.updated_at, 'updated_at'),
    expiresAt: date(row.expires_at, 'expires_at'),
    exchangeStartedAt: nullableDate(row.exchange_started_at, 'exchange_started_at'),
    finishedAt: nullableDate(row.finished_at, 'finished_at'),
  };
}

function failure(operation: string, error: unknown): RepositoryError {
  return new RepositoryError(
    `Codex device auth attempt ${operation} failed`,
    sanitizeDbError(error)
  );
}

export class CodexDeviceAuthAttemptRepository {
  constructor(private readonly db: Database) {
    if (!isPostgresDatabase(db)) {
      throw new RepositoryError('Durable Codex device auth requires PostgreSQL');
    }
  }

  async lockUser(tenantId: string, userId: UserID): Promise<void> {
    await lockTenantAuthoritySubject(this.db, tenantId, `${tenantId}\u001f${userId}`);
  }

  async allocateGeneration(tenantId: string, userId: UserID): Promise<number> {
    await this.lockUser(tenantId, userId);
    const result = await executeRaw(
      this.db,
      sql`SELECT nextval('codex_device_auth_attempt_generation_seq') AS generation`
    );
    const generation = Number(rawRows(result)[0]?.generation);
    if (!Number.isSafeInteger(generation) || generation <= 0) {
      throw new RepositoryError('Invalid Codex device auth generation');
    }
    return generation;
  }

  async createStarting(input: {
    tenantId: string;
    attemptId: CodexDeviceAuthAttemptID;
    userId: UserID;
    attemptGeneration: number;
    envelopeVersion: number;
    sealedMaterial: string;
    ttlMs: number;
  }): Promise<CodexDeviceAuthAttemptRecord> {
    try {
      await this.lockUser(input.tenantId, input.userId);
      await executeRaw(
        this.db,
        sql`UPDATE codex_device_auth_attempts
            SET status = CASE
                  WHEN status IN ('exchanging', 'persisting') THEN 'ambiguous'
                  WHEN status IN ('starting', 'pending') THEN 'superseded'
                  ELSE status
                END,
                failure_code = CASE
                  WHEN status IN ('starting', 'pending', 'exchanging', 'persisting')
                    THEN 'superseded_by_newer_attempt'
                  ELSE failure_code
                END,
                is_current = false,
                sealed_material = NULL,
                poll_claim_id = NULL,
                poll_lease_expires_at = NULL,
                updated_at = clock_timestamp(),
                finished_at = CASE
                  WHEN status IN ('starting', 'pending', 'exchanging', 'persisting')
                    THEN clock_timestamp()
                  ELSE finished_at
                END
            WHERE tenant_id = ${input.tenantId}
              AND user_id = ${input.userId}
              AND is_current = true`
      );
      const inserted = await executeRaw(
        this.db,
        sql`INSERT INTO codex_device_auth_attempts
              (tenant_id, attempt_id, user_id, attempt_generation, envelope_version,
               is_current, status, sealed_material, poll_claim_generation,
               created_at, updated_at, expires_at)
            VALUES (${input.tenantId}, ${input.attemptId}, ${input.userId},
                    ${input.attemptGeneration}, ${input.envelopeVersion}, true, 'starting',
                    ${input.sealedMaterial}, 0, clock_timestamp(), clock_timestamp(),
                    clock_timestamp() + (${input.ttlMs} * INTERVAL '1 millisecond'))
            RETURNING *`
      );
      return mapRow(rawRows(inserted)[0]!);
    } catch (error) {
      if (error instanceof RepositoryError) throw error;
      throw failure('creation', error);
    }
  }

  async attachGrant(input: {
    tenantId: string;
    attemptId: CodexDeviceAuthAttemptID;
    attemptGeneration: number;
    sealedMaterial: string;
    intervalMs: number;
    ttlMs: number;
  }): Promise<CodexDeviceAuthAttemptRecord | null> {
    try {
      const result = await executeRaw(
        this.db,
        sql`UPDATE codex_device_auth_attempts
            SET status = 'pending', sealed_material = ${input.sealedMaterial},
                poll_interval_ms = ${input.intervalMs},
                poll_next_at = clock_timestamp() + (${input.intervalMs} * INTERVAL '1 millisecond'),
                expires_at = clock_timestamp() + (${input.ttlMs} * INTERVAL '1 millisecond'),
                updated_at = clock_timestamp()
            WHERE tenant_id = ${input.tenantId}
              AND attempt_id = ${input.attemptId}
              AND attempt_generation = ${input.attemptGeneration}
              AND status = 'starting' AND is_current = true
            RETURNING *`
      );
      const row = rawRows(result)[0];
      return row ? mapRow(row) : null;
    } catch (error) {
      throw failure('grant attachment', error);
    }
  }

  async getCurrentForUser(
    tenantId: string,
    userId: UserID
  ): Promise<CodexDeviceAuthAttemptRecord | null> {
    try {
      const result = await executeRaw(
        this.db,
        sql`SELECT * FROM codex_device_auth_attempts
            WHERE tenant_id = ${tenantId} AND user_id = ${userId} AND is_current = true
            ORDER BY attempt_generation DESC LIMIT 1`
      );
      const row = rawRows(result)[0];
      return row ? mapRow(row) : null;
    } catch (error) {
      throw failure('status read', error);
    }
  }

  async getForUser(
    tenantId: string,
    userId: UserID,
    attemptId: CodexDeviceAuthAttemptID
  ): Promise<CodexDeviceAuthAttemptRecord | null> {
    try {
      const result = await executeRaw(
        this.db,
        sql`SELECT * FROM codex_device_auth_attempts
            WHERE tenant_id = ${tenantId} AND user_id = ${userId}
              AND attempt_id = ${attemptId} LIMIT 1`
      );
      const row = rawRows(result)[0];
      return row ? mapRow(row) : null;
    } catch (error) {
      throw failure('attempt read', error);
    }
  }

  async claimPoll(input: {
    tenantId: string;
    userId: UserID;
    attemptId: CodexDeviceAuthAttemptID;
    claimId: string;
    leaseMs: number;
  }): Promise<CodexDeviceAuthAttemptRecord | null> {
    try {
      await executeRaw(
        this.db,
        sql`UPDATE codex_device_auth_attempts
            SET status = 'expired', failure_code = 'authorization_timed_out',
                sealed_material = NULL, poll_claim_id = NULL,
                poll_lease_expires_at = NULL, updated_at = clock_timestamp(),
                finished_at = clock_timestamp()
            WHERE tenant_id = ${input.tenantId} AND user_id = ${input.userId}
              AND attempt_id = ${input.attemptId} AND status = 'pending'
              AND expires_at <= clock_timestamp()`
      );
      const result = await executeRaw(
        this.db,
        sql`UPDATE codex_device_auth_attempts
            SET poll_claim_id = ${input.claimId},
                poll_claim_generation = poll_claim_generation + 1,
                poll_lease_expires_at = clock_timestamp() + (${input.leaseMs} * INTERVAL '1 millisecond'),
                updated_at = clock_timestamp()
            WHERE tenant_id = ${input.tenantId} AND user_id = ${input.userId}
              AND attempt_id = ${input.attemptId}
              AND status = 'pending' AND is_current = true
              AND expires_at > clock_timestamp()
              AND poll_next_at <= clock_timestamp()
              AND (poll_lease_expires_at IS NULL OR poll_lease_expires_at <= clock_timestamp())
            RETURNING *`
      );
      const row = rawRows(result)[0];
      return row ? mapRow(row) : null;
    } catch (error) {
      throw failure('poll claim', error);
    }
  }

  async recordPending(input: {
    tenantId: string;
    attemptId: CodexDeviceAuthAttemptID;
    claimId: string;
    claimGeneration: number;
    intervalMs: number;
  }): Promise<boolean> {
    try {
      const result = await executeRaw(
        this.db,
        sql`UPDATE codex_device_auth_attempts
            SET poll_interval_ms = ${input.intervalMs},
                poll_next_at = clock_timestamp() + (${input.intervalMs} * INTERVAL '1 millisecond'),
                poll_claim_id = NULL, poll_lease_expires_at = NULL,
                updated_at = clock_timestamp()
            WHERE tenant_id = ${input.tenantId} AND attempt_id = ${input.attemptId}
              AND status = 'pending' AND is_current = true
              AND poll_claim_id = ${input.claimId}
              AND poll_claim_generation = ${input.claimGeneration}
            RETURNING attempt_id`
      );
      return rawRows(result).length === 1;
    } catch (error) {
      throw failure('pending transition', error);
    }
  }

  async finishPoll(
    record: CodexDeviceAuthAttemptRecord,
    status: 'denied' | 'failed' | 'expired',
    failureCode: string
  ): Promise<boolean> {
    assertAuthorityFailureCode(failureCode, 'Codex device auth');
    if (!record.pollClaimId) return false;
    try {
      const result = await executeRaw(
        this.db,
        sql`UPDATE codex_device_auth_attempts
            SET status = ${status}, failure_code = ${failureCode},
                sealed_material = NULL, poll_claim_id = NULL, poll_lease_expires_at = NULL,
                updated_at = clock_timestamp(), finished_at = clock_timestamp()
            WHERE tenant_id = ${record.tenantId} AND attempt_id = ${record.attemptId}
              AND status = 'pending' AND is_current = true
              AND poll_claim_id = ${record.pollClaimId}
              AND poll_claim_generation = ${record.pollClaimGeneration}
            RETURNING attempt_id`
      );
      return rawRows(result).length === 1;
    } catch (error) {
      throw failure(`${status} transition`, error);
    }
  }

  async claimExchange(
    record: CodexDeviceAuthAttemptRecord,
    exchangeClaimId: string
  ): Promise<CodexDeviceAuthAttemptRecord | null> {
    if (!record.pollClaimId) return null;
    try {
      const result = await executeRaw(
        this.db,
        sql`UPDATE codex_device_auth_attempts
            SET status = 'exchanging', exchange_claim_id = ${exchangeClaimId},
                exchange_started_at = clock_timestamp(), poll_claim_id = NULL,
                poll_lease_expires_at = NULL, updated_at = clock_timestamp()
            WHERE tenant_id = ${record.tenantId} AND attempt_id = ${record.attemptId}
              AND status = 'pending' AND is_current = true
              AND poll_claim_id = ${record.pollClaimId}
              AND poll_claim_generation = ${record.pollClaimGeneration}
            RETURNING *`
      );
      const row = rawRows(result)[0];
      return row ? mapRow(row) : null;
    } catch (error) {
      throw failure('exchange claim', error);
    }
  }

  async finishExchange(
    record: CodexDeviceAuthAttemptRecord,
    status: 'succeeded' | 'failed' | 'ambiguous',
    options: { failureCode?: string; planType?: string } = {}
  ): Promise<boolean> {
    if (!record.exchangeClaimId) return false;
    if (status === 'succeeded' && options.failureCode) {
      throw new RepositoryError('Successful Codex device auth cannot have a failure code');
    }
    if (status !== 'succeeded' && !options.failureCode) {
      throw new RepositoryError('Failed Codex device auth requires a failure code');
    }
    if (options.failureCode) {
      assertAuthorityFailureCode(options.failureCode, 'Codex device auth');
    }
    try {
      const result = await executeRaw(
        this.db,
        sql`UPDATE codex_device_auth_attempts
            SET status = ${status}, failure_code = ${options.failureCode ?? null},
                plan_type = ${options.planType ?? null},
                sealed_material = NULL, updated_at = clock_timestamp(),
                finished_at = clock_timestamp()
            WHERE tenant_id = ${record.tenantId} AND attempt_id = ${record.attemptId}
              AND status IN ('exchanging', 'persisting') AND is_current = true
              AND exchange_claim_id = ${record.exchangeClaimId}
            RETURNING attempt_id`
      );
      return rawRows(result).length === 1;
    } catch (error) {
      throw failure(`${status} exchange transition`, error);
    }
  }

  async markPersisting(record: CodexDeviceAuthAttemptRecord): Promise<boolean> {
    if (!record.exchangeClaimId) return false;
    const result = await executeRaw(
      this.db,
      sql`UPDATE codex_device_auth_attempts SET status = 'persisting', updated_at = clock_timestamp()
          WHERE tenant_id = ${record.tenantId} AND attempt_id = ${record.attemptId}
            AND status = 'exchanging' AND is_current = true
            AND exchange_claim_id = ${record.exchangeClaimId}
          RETURNING attempt_id`
    );
    return rawRows(result).length === 1;
  }

  async invalidateForUser(
    tenantId: string,
    userId: UserID,
    terminal: 'cancelled' | 'superseded',
    failureCode: string,
    attemptId?: CodexDeviceAuthAttemptID
  ): Promise<number> {
    assertAuthorityFailureCode(failureCode, 'Codex device auth');
    await this.lockUser(tenantId, userId);
    const result = await executeRaw(
      this.db,
      sql`UPDATE codex_device_auth_attempts
          SET status = CASE
                WHEN status IN ('exchanging', 'persisting') THEN 'ambiguous'
                WHEN status IN ('starting', 'pending') THEN ${terminal}
                ELSE status
              END,
              failure_code = CASE
                WHEN status IN ('starting','pending','exchanging','persisting') THEN ${failureCode}
                ELSE failure_code
              END,
              is_current = false, sealed_material = NULL,
              poll_claim_id = NULL, poll_lease_expires_at = NULL,
              updated_at = clock_timestamp(),
              finished_at = CASE
                WHEN status IN ('starting','pending','exchanging','persisting')
                  THEN clock_timestamp()
                ELSE finished_at
              END
          WHERE tenant_id = ${tenantId} AND user_id = ${userId}
            AND is_current = true
            AND (
              ${attemptId ?? null}::text IS NULL
              OR (
                attempt_id = ${attemptId ?? null}
                AND status IN ('starting','pending','exchanging','persisting')
              )
            )
          RETURNING attempt_id`
    );
    return rawRows(result).length;
  }

  async markStartingTerminal(
    tenantId: string,
    attemptId: CodexDeviceAuthAttemptID,
    status: 'unavailable' | 'failed',
    failureCode: string
  ): Promise<boolean> {
    assertAuthorityFailureCode(failureCode, 'Codex device auth');
    const result = await executeRaw(
      this.db,
      sql`UPDATE codex_device_auth_attempts
          SET status = ${status}, failure_code = ${failureCode},
              sealed_material = NULL, updated_at = clock_timestamp(), finished_at = clock_timestamp()
          WHERE tenant_id = ${tenantId} AND attempt_id = ${attemptId}
            AND status = 'starting' AND is_current = true RETURNING attempt_id`
    );
    return rawRows(result).length === 1;
  }

  async maintain(): Promise<{ expired: number; ambiguous: number; purged: number }> {
    try {
      const expired = await executeRaw(
        this.db,
        sql`UPDATE codex_device_auth_attempts
            SET status = 'expired', failure_code = 'authorization_timed_out',
                sealed_material = NULL, poll_claim_id = NULL, poll_lease_expires_at = NULL,
                updated_at = clock_timestamp(), finished_at = clock_timestamp()
            WHERE status IN ('starting','pending') AND expires_at <= clock_timestamp()`
      );
      const ambiguous = await executeRaw(
        this.db,
        sql`UPDATE codex_device_auth_attempts
            SET status = 'ambiguous', failure_code = 'exchange_owner_lost',
                sealed_material = NULL, updated_at = clock_timestamp(), finished_at = clock_timestamp()
            WHERE status IN ('exchanging','persisting')
              AND exchange_started_at <= clock_timestamp() - INTERVAL '2 minutes'`
      );
      const purged = await executeRaw(
        this.db,
        sql`DELETE FROM codex_device_auth_attempts
            WHERE status IN ('succeeded','unavailable','denied','failed','ambiguous','expired','superseded','cancelled')
              AND finished_at <= clock_timestamp() - INTERVAL '24 hours'`
      );
      return {
        expired: rawRowsAffected(expired),
        ambiguous: rawRowsAffected(ambiguous),
        purged: rawRowsAffected(purged),
      };
    } catch (error) {
      throw failure('maintenance', error);
    }
  }
}
