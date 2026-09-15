/** Nonportable, tenant-only cleanup journal; entries survive parent deletion. No provider I/O here. */
import { sql } from 'drizzle-orm';
import type { MCPServerID, UserID } from '../../types';
import {
  type MCPManagedOAuthGrantMetadata,
  MCPManagedOAuthGrantMetadataSchema,
  type MCPManagedOAuthPendingMetadata,
  MCPManagedOAuthPendingMetadataSchema,
  type MCPManagedOAuthRetirementStatus,
  managedOAuthLocalGeneration,
} from '../../types/mcp-managed-oauth';
import { McpOAuthEpochSchema, McpOAuthIdSchema } from '../../types/mcp-managed-oauth-contract';
import type { Database } from '../client';
import { executeRaw, rawRows } from '../database-wrapper';
import { openBoundSecretAsync } from '../oauth-secret-envelope';
import { assertTenantWriteGateGeneration } from '../tenant-write-gate';
import { lockTenantAuthoritySubject } from './authority-primitives';
import { RepositoryError } from './base';
import { grantSecretBinding } from './user-mcp-oauth-tokens';

export interface MCPManagedOAuthCleanupEntry {
  outbox_id: string;
  operation_id: string;
  kind: 'cancel' | 'recover_prepare_cancel' | 'close';
  attempt_id: string;
  user_id: string;
  mcp_server_id: string;
  grant_generation: string;
  transaction_id: string | null;
  cleanup_authorization_id: string | null;
  cleanup_operation_id: string | null;
  metadata: MCPManagedOAuthPendingMetadata | MCPManagedOAuthGrantMetadata;
  expires_at: Date;
}
export class MCPManagedOAuthOutboxRepository {
  constructor(private readonly db: Database) {}
  private async lock(tenantId: string): Promise<void> {
    await lockTenantAuthoritySubject(this.db, tenantId, `mcp-managed-cleanup:${tenantId}`);
  }
  async listPending(
    tenantId: string,
    limit = 100,
    afterOutboxId?: string
  ): Promise<MCPManagedOAuthCleanupEntry[]> {
    await this.lock(tenantId);
    if (afterOutboxId !== undefined) McpOAuthIdSchema.parse(afterOutboxId);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new RepositoryError('Invalid cleanup batch size');
    // Ciphertext never leaves this repository. Expiry erases revocation material, not the durable close obligation.
    await executeRaw(
      this.db,
      sql`UPDATE public.mcp_managed_oauth_outbox SET sealed_material=NULL WHERE tenant_id=${tenantId} AND expires_at<=clock_timestamp() AND sealed_material IS NOT NULL`
    );
    return rawRows(
      await executeRaw(
        this.db,
        sql`SELECT outbox_id,operation_id,kind,attempt_id,user_id,mcp_server_id,grant_generation,transaction_id,cleanup_authorization_id,cleanup_operation_id,managed_metadata,expires_at
      FROM public.mcp_managed_oauth_outbox WHERE tenant_id=${tenantId} AND completed_at IS NULL
        AND (${afterOutboxId ?? null}::text IS NULL OR outbox_id>${afterOutboxId ?? null})
      ORDER BY outbox_id LIMIT ${limit}`
      )
    ).map((row) => {
      if (!['cancel', 'recover_prepare_cancel', 'close'].includes(String(row.kind)))
        throw new RepositoryError('Invalid managed cleanup entry');
      return {
        outbox_id: String(row.outbox_id),
        operation_id: String(row.operation_id),
        kind: row.kind as MCPManagedOAuthCleanupEntry['kind'],
        attempt_id: String(row.attempt_id),
        user_id: String(row.user_id) as UserID,
        mcp_server_id: String(row.mcp_server_id) as MCPServerID,
        grant_generation: String(row.grant_generation),
        transaction_id: row.transaction_id as string | null,
        cleanup_authorization_id: row.cleanup_authorization_id as string | null,
        cleanup_operation_id: row.cleanup_operation_id as string | null,
        metadata:
          row.kind === 'close'
            ? MCPManagedOAuthGrantMetadataSchema.parse(row.managed_metadata)
            : MCPManagedOAuthPendingMetadataSchema.parse(row.managed_metadata),
        expires_at: new Date(row.expires_at as string),
      };
    });
  }
  /** Pin authenticated close delivery before opening material or attempting cleanup. */
  async bindCleanupAuthorization(
    tenantId: string,
    outboxId: string,
    operationId: string,
    authorizationId: string,
    cleanupOperationId: string
  ): Promise<boolean> {
    await this.lock(tenantId);
    McpOAuthIdSchema.parse(authorizationId);
    McpOAuthIdSchema.parse(cleanupOperationId);
    if (cleanupOperationId === operationId) throw new RepositoryError('Invalid cleanup operation');
    return (
      rawRows(
        await executeRaw(
          this.db,
          sql`
      UPDATE public.mcp_managed_oauth_outbox
      SET cleanup_authorization_id=${authorizationId},cleanup_operation_id=${cleanupOperationId}
      WHERE tenant_id=${tenantId} AND outbox_id=${outboxId} AND operation_id=${operationId}
        AND kind='close' AND completed_at IS NULL
        AND ((cleanup_authorization_id IS NULL AND cleanup_operation_id IS NULL)
          OR (cleanup_authorization_id=${authorizationId} AND cleanup_operation_id=${cleanupOperationId}))
      RETURNING outbox_id
    `
        )
      ).length === 1
    );
  }
  /** Internal revoke worker only. Obtain before complete(), leave the transaction before network I/O. */
  async openRevocationToken(
    tenantId: string,
    outboxId: string,
    operationId: string,
    masterSecret: string
  ): Promise<string | null> {
    await this.lock(tenantId);
    const row = rawRows(
      await executeRaw(
        this.db,
        sql`SELECT sealed_material,user_id,mcp_server_id,grant_generation
      FROM public.mcp_managed_oauth_outbox WHERE tenant_id=${tenantId} AND outbox_id=${outboxId} AND operation_id=${operationId}
        AND kind='close' AND completed_at IS NULL AND expires_at>clock_timestamp() AND sealed_material IS NOT NULL`
      )
    )[0];
    if (!row) return null;
    return openBoundSecretAsync(
      String(row.sealed_material),
      masterSecret,
      'refresh-token',
      grantSecretBinding(
        tenantId,
        String(row.user_id) as UserID,
        String(row.mcp_server_id) as MCPServerID,
        managedOAuthLocalGeneration(String(row.grant_generation)),
        'refresh'
      )
    );
  }

  /** Recover exactly the saved prepare operation, without activating it; then durably bind cancel. */
  async resolvePreparedCancellation(
    tenantId: string,
    outboxId: string,
    operationId: string,
    transactionId: string,
    cancelEpoch: string
  ): Promise<boolean> {
    await this.lock(tenantId);
    McpOAuthIdSchema.parse(transactionId);
    McpOAuthEpochSchema.parse(cancelEpoch);
    return (
      rawRows(
        await executeRaw(
          this.db,
          sql`UPDATE public.mcp_managed_oauth_outbox SET kind='cancel',transaction_id=${transactionId},
      managed_metadata=jsonb_set(managed_metadata,'{cancel_epoch}',to_jsonb(${cancelEpoch}::text))
      WHERE tenant_id=${tenantId} AND outbox_id=${outboxId} AND operation_id=${operationId} AND kind='recover_prepare_cancel'
        AND transaction_id IS NULL AND completed_at IS NULL RETURNING outbox_id`
        )
      ).length === 1
    );
  }
  /** Adapter calls only after the exact broker cancel/close was confirmed, not merely dispatched. */
  async completeReservationCancellation(
    tenantId: string,
    outboxId: string,
    operationId: string,
    prepareOperationId: string
  ): Promise<boolean> {
    await this.lock(tenantId);
    McpOAuthIdSchema.parse(prepareOperationId);
    // Only authenticated non-vending reservation cancellation confirms this
    // barrier. It is not a fabricated transaction or a no-dispatch certificate.
    return (
      rawRows(
        await executeRaw(
          this.db,
          sql`
      UPDATE public.mcp_managed_oauth_outbox SET completed_at=clock_timestamp(),sealed_material=NULL
      WHERE tenant_id=${tenantId} AND outbox_id=${outboxId} AND operation_id=${operationId}
        AND kind='recover_prepare_cancel' AND transaction_id IS NULL AND completed_at IS NULL
        AND managed_metadata->'prepare_request'->>'operation_id'=${prepareOperationId}
      RETURNING outbox_id
    `
        )
      ).length === 1
    );
  }

  /** Adapter calls only after the exact broker cancel/close was confirmed, not merely dispatched. */
  async complete(tenantId: string, outboxId: string, operationId: string): Promise<boolean> {
    await this.lock(tenantId);
    return (
      rawRows(
        await executeRaw(
          this.db,
          sql`UPDATE public.mcp_managed_oauth_outbox SET completed_at=clock_timestamp(),sealed_material=NULL
      WHERE tenant_id=${tenantId} AND outbox_id=${outboxId} AND operation_id=${operationId} AND kind IN ('cancel','close') AND completed_at IS NULL RETURNING outbox_id`
        )
      ).length === 1
    );
  }
  /**
   * Trusted lifecycle adapter only; caller holds a tenant transaction, never network I/O.
   * Optional cellId narrows every mutation to that saved owner. The deployment caller
   * verifies its immutable cell barrier separately; omission means explicit full-tenant retirement.
   */
  async retireTenantUnderWriteGate(
    tenantId: string,
    gateGeneration: string,
    cellId?: string
  ): Promise<void> {
    // Gate row first: identical ordering to the existing destructive deletion fence.
    if (cellId !== undefined) McpOAuthIdSchema.parse(cellId);
    await assertTenantWriteGateGeneration(this.db, tenantId, gateGeneration);
    await this.retireTenant(tenantId, cellId);
  }

  /** Fresh readiness, not a portable certificate; valid only while this exact gate remains held. */
  async isTenantRetirementReady(
    tenantId: string,
    gateGeneration: string,
    cellId?: string
  ): Promise<boolean> {
    return (await this.getTenantRetirementStatus(tenantId, gateGeneration, cellId)).ready;
  }

  async getTenantRetirementStatus(
    tenantId: string,
    gateGeneration: string,
    cellId?: string
  ): Promise<MCPManagedOAuthRetirementStatus> {
    if (cellId !== undefined) McpOAuthIdSchema.parse(cellId);
    await assertTenantWriteGateGeneration(this.db, tenantId, gateGeneration);
    await this.lock(tenantId);
    const [row] = rawRows(
      await executeRaw(
        this.db,
        sql`
      SELECT
        (SELECT count(*)::text FROM public.mcp_managed_oauth_outbox
          WHERE tenant_id=${tenantId}
          AND (${cellId ?? null}::text IS NULL OR managed_metadata->'owner'->>'cell_id'=${cellId ?? null}) AND completed_at IS NULL) AS pending_cleanup,
        (SELECT count(*)::text FROM public.user_mcp_oauth_tokens
          WHERE tenant_id=${tenantId}
          AND (${cellId ?? null}::text IS NULL OR managed_metadata->'owner'->>'cell_id'=${cellId ?? null}) AND credential_origin='cloud_managed_v1') AS active_grants,
        (SELECT count(*)::text FROM public.mcp_oauth_pending_flows
          WHERE tenant_id=${tenantId}
          AND (${cellId ?? null}::text IS NULL OR managed_metadata->'owner'->>'cell_id'=${cellId ?? null}) AND credential_origin='cloud_managed_v1'
            AND status IN ('pending','exchanging')) AS pending_attempts
    `
      )
    );
    const count = (value: unknown): number => {
      if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value))
        throw new RepositoryError('Invalid managed retirement count');
      const n = Number(value);
      if (!Number.isSafeInteger(n) || n < 0)
        throw new RepositoryError('Unsafe managed retirement count');
      return n;
    };
    const pending_attempts = count(row?.pending_attempts);
    const active_grants = count(row?.active_grants);
    const pending_cleanup = count(row?.pending_cleanup);
    return {
      ready: pending_attempts === 0 && active_grants === 0 && pending_cleanup === 0,
      pending_attempts,
      active_grants,
      pending_cleanup,
    };
  }

  /** Lifecycle close, before tenant erasure. Existing attempt/token owners produce exact-old cleanup entries. */
  async retireTenant(tenantId: string, cellId?: string): Promise<void> {
    if (cellId !== undefined) McpOAuthIdSchema.parse(cellId);
    await this.lock(tenantId);
    await executeRaw(
      this.db,
      sql`UPDATE public.mcp_oauth_pending_flows SET status=CASE WHEN status='exchanging' THEN 'ambiguous' ELSE 'failed' END,
      is_current=false,sealed_material=NULL,failure_code='tenant_retired',finished_at=clock_timestamp(),updated_at=clock_timestamp()
      WHERE tenant_id=${tenantId}
          AND (${cellId ?? null}::text IS NULL OR managed_metadata->'owner'->>'cell_id'=${cellId ?? null}) AND credential_origin='cloud_managed_v1' AND status IN ('pending','exchanging')`
    );
    await executeRaw(
      this.db,
      sql`DELETE FROM public.user_mcp_oauth_tokens WHERE tenant_id=${tenantId}
          AND (${cellId ?? null}::text IS NULL OR managed_metadata->'owner'->>'cell_id'=${cellId ?? null}) AND credential_origin='cloud_managed_v1'`
    );
  }
}
