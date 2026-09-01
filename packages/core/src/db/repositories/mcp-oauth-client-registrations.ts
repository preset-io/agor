/** PostgreSQL lease/CAS authority for OAuth Dynamic Client Registration. */

import type {
  MCPOAuthClientRegistrationID,
  MCPOAuthClientRegistrationStatus,
  MCPServerID,
} from '@agor/core/types';
import { sql } from 'drizzle-orm';
import type { Database } from '../client';
import { executeRaw, isPostgresDatabase, rawRows, rawRowsAffected } from '../database-wrapper';
import { sanitizeDbError } from '../sanitize-error';
import { lockTenantAuthoritySubject } from './authority-primitives';
import { RepositoryError } from './base';

const SHA256_HEX = /^[a-f0-9]{64}$/;
// A reused client secret must remain valid for the full browser-attempt TTL
// (10 minutes) plus a small callback/commit margin.
const MINIMUM_CLIENT_SECRET_VALIDITY_MS = 11 * 60 * 1000;
const TERMINAL = ['failed', 'ambiguous', 'superseded', 'expired'] as const;
const STATUSES: readonly MCPOAuthClientRegistrationStatus[] = [
  'registering',
  'registered',
  ...TERMINAL,
];

export interface MCPOAuthClientRegistrationRecord {
  tenantId: string;
  registrationId: MCPOAuthClientRegistrationID;
  mcpServerId: MCPServerID;
  registrationGeneration: number;
  bindingVersion: number;
  bindingFingerprint: string;
  serverConfigVersion: number;
  envelopeVersion: number;
  isCurrent: boolean;
  status: MCPOAuthClientRegistrationStatus;
  sealedMaterial: string | null;
  claimId: string | null;
  claimGeneration: number;
  leaseExpiresAt: Date | null;
  dispatchedAt: Date | null;
  clientSecretExpiresAt: Date | null;
  failureCode: string | null;
  createdAt: Date;
  updatedAt: Date;
  finishedAt: Date | null;
}

export type MCPOAuthClientRegistrationClaimResult =
  | { outcome: 'owner'; registration: MCPOAuthClientRegistrationRecord }
  | { outcome: 'ready'; registration: MCPOAuthClientRegistrationRecord }
  | { outcome: 'waiting'; registration: MCPOAuthClientRegistrationRecord };

function asDate(value: unknown, field: string): Date {
  const result = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(result.getTime())) {
    throw new RepositoryError(`MCP OAuth client registration has invalid ${field}`);
  }
  return result;
}

function nullableDate(value: unknown, field: string): Date | null {
  return value == null ? null : asDate(value, field);
}

function mapRow(row: Record<string, unknown>): MCPOAuthClientRegistrationRecord {
  const status = String(row.status) as MCPOAuthClientRegistrationStatus;
  if (
    typeof row.tenant_id !== 'string' ||
    typeof row.registration_id !== 'string' ||
    typeof row.mcp_server_id !== 'string' ||
    !Number.isSafeInteger(Number(row.registration_generation)) ||
    Number(row.registration_generation) <= 0 ||
    Number(row.binding_version) !== 1 ||
    typeof row.binding_fingerprint !== 'string' ||
    !SHA256_HEX.test(row.binding_fingerprint) ||
    !Number.isSafeInteger(Number(row.server_config_version)) ||
    Number(row.server_config_version) < 1 ||
    !Number.isSafeInteger(Number(row.envelope_version)) ||
    typeof row.is_current !== 'boolean' ||
    !STATUSES.includes(status) ||
    (row.sealed_material != null && typeof row.sealed_material !== 'string') ||
    (row.claim_id != null && typeof row.claim_id !== 'string') ||
    !Number.isSafeInteger(Number(row.claim_generation)) ||
    Number(row.claim_generation) < 0 ||
    (row.failure_code != null && typeof row.failure_code !== 'string')
  ) {
    throw new RepositoryError('MCP OAuth client registration row is invalid');
  }
  return {
    tenantId: row.tenant_id,
    registrationId: row.registration_id as MCPOAuthClientRegistrationID,
    mcpServerId: row.mcp_server_id as MCPServerID,
    registrationGeneration: Number(row.registration_generation),
    bindingVersion: Number(row.binding_version),
    bindingFingerprint: row.binding_fingerprint,
    serverConfigVersion: Number(row.server_config_version),
    envelopeVersion: Number(row.envelope_version),
    isCurrent: row.is_current,
    status,
    sealedMaterial: (row.sealed_material as string | null) ?? null,
    claimId: (row.claim_id as string | null) ?? null,
    claimGeneration: Number(row.claim_generation),
    leaseExpiresAt: nullableDate(row.lease_expires_at, 'lease_expires_at'),
    dispatchedAt: nullableDate(row.dispatched_at, 'dispatched_at'),
    clientSecretExpiresAt: nullableDate(row.client_secret_expires_at, 'client_secret_expires_at'),
    failureCode: (row.failure_code as string | null) ?? null,
    createdAt: asDate(row.created_at, 'created_at'),
    updatedAt: asDate(row.updated_at, 'updated_at'),
    finishedAt: nullableDate(row.finished_at, 'finished_at'),
  };
}

function failure(operation: string, error: unknown): RepositoryError {
  return new RepositoryError(
    `MCP OAuth client registration ${operation} failed`,
    sanitizeDbError(error)
  );
}

export class MCPOAuthClientRegistrationRepository {
  constructor(private readonly db: Database) {
    if (!isPostgresDatabase(db)) {
      throw new RepositoryError('Durable MCP OAuth client registration requires PostgreSQL');
    }
  }

  private async lockServer(tenantId: string, serverId: MCPServerID): Promise<void> {
    await lockTenantAuthoritySubject(
      this.db,
      tenantId,
      `${tenantId}\u001fmcp-oauth-dcr\u001f${serverId}`
    );
  }

  async claimOrObserve(input: {
    tenantId: string;
    registrationId: MCPOAuthClientRegistrationID;
    mcpServerId: MCPServerID;
    bindingFingerprint: string;
    serverConfigVersion: number;
    envelopeVersion: number;
    claimId: string;
    leaseMs: number;
  }): Promise<MCPOAuthClientRegistrationClaimResult> {
    if (!SHA256_HEX.test(input.bindingFingerprint)) {
      throw new RepositoryError('MCP OAuth client registration binding is invalid');
    }
    if (!Number.isSafeInteger(input.serverConfigVersion) || input.serverConfigVersion < 1) {
      throw new RepositoryError('MCP OAuth client registration config version is invalid');
    }
    if (!Number.isSafeInteger(input.leaseMs) || input.leaseMs < 20_000 || input.leaseMs > 120_000) {
      throw new RepositoryError('MCP OAuth client registration lease is invalid');
    }
    try {
      await this.lockServer(input.tenantId, input.mcpServerId);
      const currentResult = await executeRaw(
        this.db,
        sql`SELECT *,
                   (client_secret_expires_at IS NULL OR
                    client_secret_expires_at > clock_timestamp() +
                      (${MINIMUM_CLIENT_SECRET_VALIDITY_MS} * INTERVAL '1 millisecond'))
                     AS client_secret_live,
                   (lease_expires_at IS NOT NULL AND lease_expires_at > clock_timestamp())
                     AS lease_live
            FROM mcp_oauth_client_registrations
            WHERE tenant_id = ${input.tenantId}
              AND mcp_server_id = ${input.mcpServerId}
              AND is_current = true
            ORDER BY registration_generation DESC
            LIMIT 1`
      );
      const currentRow = rawRows(currentResult)[0];
      let current = currentRow ? mapRow(currentRow) : null;
      const currentSecretLive = currentRow?.client_secret_live === true;
      const currentLeaseLive = currentRow?.lease_live === true;
      const exactBinding =
        current?.bindingFingerprint === input.bindingFingerprint &&
        current.serverConfigVersion === input.serverConfigVersion;

      if (current?.status === 'registered' && exactBinding && currentSecretLive) {
        return { outcome: 'ready', registration: current };
      }

      if (current?.status === 'registering' && exactBinding) {
        const reclaimed = await executeRaw(
          this.db,
          sql`UPDATE mcp_oauth_client_registrations
              SET claim_id = ${input.claimId},
                  claim_generation = claim_generation + 1,
                  lease_expires_at = clock_timestamp() + (${input.leaseMs} * INTERVAL '1 millisecond'),
                  updated_at = clock_timestamp()
              WHERE tenant_id = ${input.tenantId}
                AND registration_id = ${current.registrationId}
                AND status = 'registering' AND is_current = true
                AND dispatched_at IS NULL
                AND lease_expires_at <= clock_timestamp()
              RETURNING *`
        );
        const reclaimedRow = rawRows(reclaimed)[0];
        if (reclaimedRow) {
          return { outcome: 'owner', registration: mapRow(reclaimedRow) };
        }
        if (currentLeaseLive) {
          return { outcome: 'waiting', registration: current };
        }
        // A dispatched owner that vanished may have created a client. Preserve
        // that uncertainty and rotate to a fresh generation instead of letting
        // a new replica publish into the old claim.
        await executeRaw(
          this.db,
          sql`UPDATE mcp_oauth_client_registrations
              SET status = 'ambiguous', is_current = false,
                  sealed_material = NULL, claim_id = NULL, lease_expires_at = NULL,
                  failure_code = 'registration_owner_lost', updated_at = clock_timestamp(),
                  finished_at = clock_timestamp()
              WHERE tenant_id = ${input.tenantId}
                AND registration_id = ${current.registrationId}
                AND status = 'registering' AND is_current = true
                AND lease_expires_at <= clock_timestamp()`
        );
        current = null;
      }

      if (current) {
        const status =
          current.status === 'registering' && current.dispatchedAt
            ? 'ambiguous'
            : current.status === 'registered' && !currentSecretLive
              ? 'expired'
              : 'superseded';
        await executeRaw(
          this.db,
          sql`UPDATE mcp_oauth_client_registrations
              SET status = ${status}, is_current = false, sealed_material = NULL,
                  claim_id = NULL, lease_expires_at = NULL,
                  failure_code = ${status === 'expired' ? 'client_secret_expired' : 'server_configuration_changed'},
                  updated_at = clock_timestamp(), finished_at = clock_timestamp()
              WHERE tenant_id = ${input.tenantId}
                AND registration_id = ${current.registrationId}
                AND is_current = true`
        );
      }

      const generationResult = await executeRaw(
        this.db,
        sql`SELECT nextval('mcp_oauth_client_registration_generation_seq') AS generation`
      );
      const generation = Number(rawRows(generationResult)[0]?.generation);
      if (!Number.isSafeInteger(generation) || generation <= 0) {
        throw new RepositoryError('MCP OAuth client registration generation is invalid');
      }
      const inserted = await executeRaw(
        this.db,
        sql`INSERT INTO mcp_oauth_client_registrations
              (tenant_id, registration_id, mcp_server_id, registration_generation,
               binding_version, binding_fingerprint, server_config_version,
               envelope_version, is_current, status, claim_id, claim_generation,
               lease_expires_at, created_at, updated_at)
            VALUES (${input.tenantId}, ${input.registrationId}, ${input.mcpServerId},
                    ${generation}, 1, ${input.bindingFingerprint}, ${input.serverConfigVersion},
                    ${input.envelopeVersion}, true, 'registering', ${input.claimId}, 1,
                    clock_timestamp() + (${input.leaseMs} * INTERVAL '1 millisecond'),
                    clock_timestamp(), clock_timestamp())
            RETURNING *`
      );
      return { outcome: 'owner', registration: mapRow(rawRows(inserted)[0]!) };
    } catch (error) {
      if (error instanceof RepositoryError) throw error;
      throw failure('claim', error);
    }
  }

  async getCurrent(
    tenantId: string,
    mcpServerId: MCPServerID
  ): Promise<MCPOAuthClientRegistrationRecord | null> {
    try {
      const result = await executeRaw(
        this.db,
        sql`SELECT * FROM mcp_oauth_client_registrations
            WHERE tenant_id = ${tenantId} AND mcp_server_id = ${mcpServerId}
              AND is_current = true
            ORDER BY registration_generation DESC LIMIT 1`
      );
      const row = rawRows(result)[0];
      return row ? mapRow(row) : null;
    } catch (error) {
      throw failure('read', error);
    }
  }

  async markDispatched(record: MCPOAuthClientRegistrationRecord): Promise<boolean> {
    if (!record.claimId) return false;
    try {
      const result = await executeRaw(
        this.db,
        sql`UPDATE mcp_oauth_client_registrations
            SET dispatched_at = clock_timestamp(), updated_at = clock_timestamp()
            WHERE tenant_id = ${record.tenantId}
              AND registration_id = ${record.registrationId}
              AND registration_generation = ${record.registrationGeneration}
              AND status = 'registering' AND is_current = true
              AND claim_id = ${record.claimId}
              AND claim_generation = ${record.claimGeneration}
              AND lease_expires_at > clock_timestamp()
              AND dispatched_at IS NULL
            RETURNING registration_id`
      );
      return rawRows(result).length === 1;
    } catch (error) {
      throw failure('dispatch claim', error);
    }
  }

  async finishRegistered(
    record: MCPOAuthClientRegistrationRecord,
    sealedMaterial: string,
    clientSecretExpiresAt?: Date
  ): Promise<boolean> {
    if (!record.claimId || !sealedMaterial) return false;
    if (clientSecretExpiresAt && !Number.isFinite(clientSecretExpiresAt.getTime())) return false;
    try {
      const result = await executeRaw(
        this.db,
        sql`UPDATE mcp_oauth_client_registrations
            SET status = 'registered', sealed_material = ${sealedMaterial},
                client_secret_expires_at = ${
                  clientSecretExpiresAt
                    ? sql`to_timestamp(${clientSecretExpiresAt.getTime() / 1000})`
                    : null
                },
                claim_id = NULL, lease_expires_at = NULL, failure_code = NULL,
                updated_at = clock_timestamp()
            WHERE tenant_id = ${record.tenantId}
              AND registration_id = ${record.registrationId}
              AND registration_generation = ${record.registrationGeneration}
              AND status = 'registering' AND is_current = true
              AND claim_id = ${record.claimId}
              AND claim_generation = ${record.claimGeneration}
              AND dispatched_at IS NOT NULL
              AND lease_expires_at > clock_timestamp()
              AND ${
                clientSecretExpiresAt
                  ? sql`to_timestamp(${clientSecretExpiresAt.getTime() / 1000}) >
                        clock_timestamp() +
                          (${MINIMUM_CLIENT_SECRET_VALIDITY_MS} * INTERVAL '1 millisecond')`
                  : sql`true`
              }
            RETURNING registration_id`
      );
      return rawRows(result).length === 1;
    } catch (error) {
      throw failure('completion', error);
    }
  }

  async finishFailure(
    record: MCPOAuthClientRegistrationRecord,
    status: 'failed' | 'ambiguous',
    failureCode: string
  ): Promise<boolean> {
    if (!record.claimId || !/^[a-z0-9_]{1,64}$/.test(failureCode)) return false;
    try {
      const result = await executeRaw(
        this.db,
        sql`UPDATE mcp_oauth_client_registrations
            SET status = ${status}, is_current = false, sealed_material = NULL,
                claim_id = NULL, lease_expires_at = NULL, failure_code = ${failureCode},
                updated_at = clock_timestamp(), finished_at = clock_timestamp()
            WHERE tenant_id = ${record.tenantId}
              AND registration_id = ${record.registrationId}
              AND registration_generation = ${record.registrationGeneration}
              AND status = 'registering' AND is_current = true
              AND claim_id = ${record.claimId}
              AND claim_generation = ${record.claimGeneration}
            RETURNING registration_id`
      );
      return rawRows(result).length === 1;
    } catch (error) {
      throw failure(`${status} transition`, error);
    }
  }

  async invalidateForServer(tenantId: string, serverId: MCPServerID): Promise<number> {
    try {
      const result = await executeRaw(
        this.db,
        sql`UPDATE mcp_oauth_client_registrations
            SET status = CASE
                  WHEN status = 'registering' AND dispatched_at IS NOT NULL THEN 'ambiguous'
                  ELSE 'superseded'
                END,
                is_current = false, sealed_material = NULL, claim_id = NULL,
                lease_expires_at = NULL, failure_code = 'server_configuration_changed',
                updated_at = clock_timestamp(), finished_at = clock_timestamp()
            WHERE tenant_id = ${tenantId} AND mcp_server_id = ${serverId}
              AND is_current = true`
      );
      return rawRowsAffected(result);
    } catch (error) {
      throw failure('server invalidation', error);
    }
  }

  async invalidateRegistration(record: MCPOAuthClientRegistrationRecord): Promise<boolean> {
    try {
      const result = await executeRaw(
        this.db,
        sql`UPDATE mcp_oauth_client_registrations
            SET status = 'superseded', is_current = false, sealed_material = NULL,
                claim_id = NULL, lease_expires_at = NULL,
                failure_code = 'registration_material_invalid',
                updated_at = clock_timestamp(), finished_at = clock_timestamp()
            WHERE tenant_id = ${record.tenantId}
              AND registration_id = ${record.registrationId}
              AND registration_generation = ${record.registrationGeneration}
              AND binding_fingerprint = ${record.bindingFingerprint}
              AND status = 'registered' AND is_current = true
            RETURNING registration_id`
      );
      return rawRows(result).length === 1;
    } catch (error) {
      throw failure('material invalidation', error);
    }
  }

  async maintain(): Promise<{ abandoned: number; expired: number; purged: number }> {
    try {
      const abandoned = await executeRaw(
        this.db,
        sql`UPDATE mcp_oauth_client_registrations
            SET status = CASE WHEN dispatched_at IS NULL THEN 'failed' ELSE 'ambiguous' END,
                is_current = false, sealed_material = NULL, claim_id = NULL,
                lease_expires_at = NULL, failure_code = 'registration_owner_lost',
                updated_at = clock_timestamp(), finished_at = clock_timestamp()
            WHERE status = 'registering' AND is_current = true
              AND lease_expires_at <= clock_timestamp()`
      );
      const expired = await executeRaw(
        this.db,
        sql`UPDATE mcp_oauth_client_registrations
            SET status = 'expired', is_current = false, sealed_material = NULL,
                failure_code = 'client_secret_expired', updated_at = clock_timestamp(),
                finished_at = clock_timestamp()
            WHERE status = 'registered' AND is_current = true
              AND client_secret_expires_at IS NOT NULL
              AND client_secret_expires_at <= clock_timestamp()`
      );
      const purged = await executeRaw(
        this.db,
        sql`DELETE FROM mcp_oauth_client_registrations
            WHERE status IN ('failed','ambiguous','superseded','expired')
              AND finished_at <= clock_timestamp() - INTERVAL '24 hours'`
      );
      return {
        abandoned: rawRowsAffected(abandoned),
        expired: rawRowsAffected(expired),
        purged: rawRowsAffected(purged),
      };
    } catch (error) {
      throw failure('maintenance', error);
    }
  }
}
