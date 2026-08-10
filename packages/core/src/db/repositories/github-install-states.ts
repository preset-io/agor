/**
 * PostgreSQL authority for GitHub App installation setup state.
 *
 * The raw high-entropy state never crosses this boundary. Callers provide only
 * its SHA-256 exact-lookup hash. Tenant discovery is deliberately separated
 * from tenant-scoped issuance/consumption so the unauthenticated provider
 * callback gains no general tenant database capability.
 */

import { and, asc, eq, gt, lte, sql } from 'drizzle-orm';
import type { Database, SystemDatabase } from '../client';
import { executeRaw, isPostgresDatabase, select } from '../database-wrapper';
import { sanitizeDbError } from '../sanitize-error';
import { githubInstallStates } from '../schema';
import { RepositoryError } from './base';

const STATE_HASH = /^[a-f0-9]{64}$/;
const MAX_DISCOVERY_TENANTS = 10_000;

export interface GitHubInstallStateIssue {
  tenantId: string;
  stateHash: string;
  userId: string;
  intent: string;
  createdAt: Date;
  expiresAt: Date;
}

export interface ConsumedGitHubInstallState {
  tenantId: string;
  userId: string;
  expired: boolean;
}

function rowsOf(result: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(result)) return result as Array<Record<string, unknown>>;
  const rows = (result as { rows?: unknown[] } | undefined)?.rows;
  return Array.isArray(rows) ? (rows as Array<Record<string, unknown>>) : [];
}

function assertStateHash(stateHash: string): void {
  if (!STATE_HASH.test(stateHash)) {
    throw new RepositoryError('GitHub install state hash is invalid');
  }
}

function assertIntent(intent: string): void {
  if (!intent || typeof intent !== 'string' || intent.length > 128) {
    throw new RepositoryError('GitHub install state intent is invalid');
  }
}

function databaseFailure(operation: string, error: unknown): RepositoryError {
  // Driver errors can retain the bound state hash. Preserve only sanitized
  // database metadata and a stable operation category.
  return new RepositoryError(`GitHub install state ${operation} failed`, sanitizeDbError(error));
}

function requirePostgres(db: Database, operation: string): void {
  if (!isPostgresDatabase(db)) {
    throw new RepositoryError(`GitHub install state ${operation} requires PostgreSQL`);
  }
}

/** Tenant-scoped issuance, atomic consumption, and expiry deletion. */
export class GitHubInstallStateRepository {
  constructor(private readonly db: Database) {
    requirePostgres(db, 'authority');
  }

  async issue(input: GitHubInstallStateIssue): Promise<void> {
    assertStateHash(input.stateHash);
    assertIntent(input.intent);
    if (!input.tenantId || !input.userId) {
      throw new RepositoryError('GitHub install state binding is incomplete');
    }
    if (
      !Number.isFinite(input.createdAt.getTime()) ||
      !Number.isFinite(input.expiresAt.getTime()) ||
      input.expiresAt <= input.createdAt
    ) {
      throw new RepositoryError('GitHub install state lifetime is invalid');
    }

    try {
      const lifetimeMs = input.expiresAt.getTime() - input.createdAt.getTime();
      // PostgreSQL is the fleet authority for both one-shot consumption and
      // expiry. Derive both timestamps from its clock so skew on an issuing
      // daemon cannot shorten or extend the security lifetime.
      await executeRaw(
        this.db,
        sql`
          INSERT INTO ${githubInstallStates}
            (tenant_id, state_hash, user_id, intent, created_at, expires_at)
          VALUES (
            ${input.tenantId}, ${input.stateHash}, ${input.userId}, ${input.intent},
            CURRENT_TIMESTAMP,
            CURRENT_TIMESTAMP + ${lifetimeMs} * INTERVAL '1 millisecond'
          )
        `
      );
    } catch (error) {
      throw databaseFailure('issuance', error);
    }
  }

  /**
   * Atomically delete and return one matching state in the active tenant.
   * PostgreSQL serializes competing DELETEs, so exactly one daemon can receive
   * the row. Expired rows are also deleted and reported as expired.
   */
  async consume(stateHash: string, intent: string): Promise<ConsumedGitHubInstallState | null> {
    assertStateHash(stateHash);
    assertIntent(intent);
    try {
      const result = await executeRaw(
        this.db,
        sql`
          DELETE FROM ${githubInstallStates}
          WHERE state_hash = ${stateHash}
            AND intent = ${intent}
          RETURNING tenant_id,
                    user_id,
                    expires_at <= CURRENT_TIMESTAMP AS expired
        `
      );
      const row = rowsOf(result)[0];
      if (!row) return null;
      if (
        typeof row.tenant_id !== 'string' ||
        !row.tenant_id ||
        typeof row.user_id !== 'string' ||
        !row.user_id ||
        typeof row.expired !== 'boolean'
      ) {
        throw new RepositoryError('GitHub install state consumption returned invalid binding');
      }
      return {
        tenantId: row.tenant_id,
        userId: row.user_id,
        expired: row.expired,
      };
    } catch (error) {
      if (error instanceof RepositoryError) throw error;
      throw databaseFailure('consumption', error);
    }
  }

  async purgeExpired(): Promise<number> {
    try {
      const result = await executeRaw(
        this.db,
        sql`
          WITH purged AS (
            DELETE FROM ${githubInstallStates}
            WHERE expires_at <= CURRENT_TIMESTAMP
            RETURNING 1
          )
          SELECT count(*) AS count FROM purged
        `
      );
      return Number(rowsOf(result)[0]?.count ?? 0);
    } catch (error) {
      throw databaseFailure('expiry cleanup', error);
    }
  }
}

/**
 * Capability-specific, routing-only cross-tenant discovery.
 *
 * The callback method accepts an exact hash+intent and returns only its owning
 * tenant. Maintenance returns only tenant IDs that currently have expired rows.
 */
export class GitHubInstallStateDiscoveryRepository {
  constructor(private readonly db: SystemDatabase) {
    requirePostgres(db, 'discovery');
  }

  async findTenantId(stateHash: string, intent: string): Promise<string | null> {
    assertStateHash(stateHash);
    assertIntent(intent);
    try {
      const tenantColumn = (
        githubInstallStates as unknown as { tenant_id?: typeof githubInstallStates.state_hash }
      ).tenant_id;
      if (!tenantColumn) {
        throw new RepositoryError('GitHub install state tenant metadata is unavailable');
      }
      const row = await select(this.db, { tenant_id: tenantColumn })
        .from(githubInstallStates)
        .where(
          and(eq(githubInstallStates.state_hash, stateHash), eq(githubInstallStates.intent, intent))
        )
        .one();
      if (!row) return null;
      if (typeof row.tenant_id !== 'string' || !row.tenant_id) {
        throw new RepositoryError('GitHub install state discovery returned invalid tenant routing');
      }
      return row.tenant_id;
    } catch (error) {
      if (error instanceof RepositoryError) throw error;
      throw databaseFailure('callback discovery', error);
    }
  }

  async findExpiredTenantIds(limit = 1_000, afterTenantId?: string): Promise<string[]> {
    if (!Number.isInteger(limit) || limit <= 0 || limit > MAX_DISCOVERY_TENANTS) {
      throw new RepositoryError('GitHub install state cleanup limit is invalid');
    }
    if (afterTenantId !== undefined && !afterTenantId) {
      throw new RepositoryError('GitHub install state cleanup cursor is invalid');
    }
    try {
      const tenantColumn = (
        githubInstallStates as unknown as { tenant_id?: typeof githubInstallStates.state_hash }
      ).tenant_id;
      if (!tenantColumn) {
        throw new RepositoryError('GitHub install state tenant metadata is unavailable');
      }
      const rows = await select(this.db, { tenant_id: tenantColumn })
        .from(githubInstallStates)
        .where(
          afterTenantId === undefined
            ? lte(githubInstallStates.expires_at, sql`CURRENT_TIMESTAMP`)
            : and(
                lte(githubInstallStates.expires_at, sql`CURRENT_TIMESTAMP`),
                gt(tenantColumn, afterTenantId)
              )
        )
        .groupBy(tenantColumn)
        .orderBy(asc(tenantColumn))
        .limit(limit)
        .all();
      return (rows as Array<{ tenant_id?: unknown }>).map((row) => {
        if (typeof row.tenant_id !== 'string' || !row.tenant_id) {
          throw new RepositoryError('GitHub install state cleanup returned invalid tenant routing');
        }
        return row.tenant_id;
      });
    } catch (error) {
      if (error instanceof RepositoryError) throw error;
      throw databaseFailure('cleanup discovery', error);
    }
  }
}
