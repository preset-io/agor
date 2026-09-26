import { and, eq, sql } from 'drizzle-orm';
import { generateId } from '../../lib/ids';
import {
  BRANCH_MAINTENANCE_DISCOVERY_PAGE_SIZE,
  type BranchID,
  type BranchMaintenanceClaim,
  type BranchMaintenanceRoutingRef,
  isTeammate,
  type TenantID,
  type UserID,
  type UUID,
} from '../../types';
import { hasActiveEnvironmentCommand } from '../../types/environment-command';
import { lockBranchReferenceMutation } from '../branch-reference-admission';
import type { Database } from '../client';
import {
  executeRaw,
  isPostgresDatabase,
  jsonExtract,
  jsonRemoveProperty,
  lockRowForUpdate,
  rawRows,
  runDatabaseTransaction,
  select,
  update,
} from '../database-wrapper';
import { assertNotPrimaryTeammate } from '../primary-teammate-protection';
import { branches, sessions, uploads, users } from '../schema';
import { requireCurrentTenantId } from '../tenant-context';
import { assertTenantWritable } from '../tenant-write-gate';
import { EntityNotFoundError, RepositoryError } from './base';
import { BranchRepository } from './branches';
import { TaskRepository } from './tasks';

/**
 * One Branch-row owner shared by deletion and cleanup. This is admission and
 * CAS persistence, not another executor supervisor. No leases: time passing
 * cannot establish that an external invocation stopped. Callers authorize
 * before claiming and do external work outside these short transactions.
 */
export class BranchMaintenanceRepository {
  constructor(private readonly db: Database) {}

  private async now(db: Database, branchId: BranchID): Promise<Date> {
    if (!isPostgresDatabase(db)) return new Date();
    const row = await select(db, { now: sql<Date>`clock_timestamp()` })
      .from(branches)
      .where(eq(branches.branch_id, branchId))
      .one();
    if (!row) throw new EntityNotFoundError('Branch', branchId);
    return new Date(row.now);
  }

  private async locked<T>(
    branchId: BranchID,
    work: (db: Database, row: typeof branches.$inferSelect) => Promise<T>
  ) {
    if (isPostgresDatabase(this.db)) await assertTenantWritable(this.db, requireCurrentTenantId());
    return runDatabaseTransaction(
      this.db,
      async (tx) => {
        await lockRowForUpdate(tx, this.db, branches, eq(branches.branch_id, branchId));
        const row = await select(tx).from(branches).where(eq(branches.branch_id, branchId)).one();
        if (!row) throw new EntityNotFoundError('Branch', branchId);
        return work(tx, row);
      },
      { sqliteImmediate: true, sqliteBusyRetries: 9 }
    );
  }

  /**
   * Explicit Manager retirement (authorization belongs to validate). Personal
   * routing preferences are not management vetoes. Board primaries still need
   * their board's deliberate reassignment. No files are touched by this method.
   */
  async claimForTeammateRetirement(
    branchId: BranchID,
    requestedBy: UserID,
    validate: (tx: Database) => Promise<void>
  ) {
    return runDatabaseTransaction(
      this.db,
      async (tx) => {
        // Same order as primary designation: tenant references, then Branch.
        await lockBranchReferenceMutation(tx);
        const admission = await new BranchMaintenanceRepository(tx).claim(
          branchId,
          'cleanup',
          requestedBy,
          async (locked) => {
            await validate(locked);
            const branch = await new BranchRepository(locked).findById(branchId);
            if (!branch || !isTeammate(branch) || branch.archived)
              throw new RepositoryError('Retirement requires an active teammate');
            await update(locked, users)
              .set({
                updated_at: new Date(),
                data: jsonRemoveProperty(locked, users.data, 'primary_teammate_id'),
              })
              .where(eq(jsonExtract(locked, users.data, 'primary_teammate_id'), branchId))
              .run();
          }
        );
        if (!admission.acquired)
          throw new RepositoryError(
            'Branch maintenance is already active; reconcile before retirement'
          );
        // Atomic with preference removal and the producer fence. A concurrent
        // designation either wins before retirement or sees an archived branch.
        await update(tx, branches)
          .set({ archived: true, archived_at: new Date(), archived_by: requestedBy })
          .where(eq(branches.branch_id, branchId))
          .run();
        return admission;
      },
      { sqliteImmediate: true, sqliteBusyRetries: 9 }
    );
  }

  async claim(
    branchId: BranchID,
    kind: BranchMaintenanceClaim['kind'],
    requestedBy?: UserID,
    validate?: (tx: Database) => Promise<void>
  ): Promise<{ claim: BranchMaintenanceClaim; acquired: boolean }> {
    return this.locked(branchId, async (tx, row) => {
      await validate?.(tx);
      if (kind === 'cleanup' || kind === 'delete') await assertNotPrimaryTeammate(tx, branchId);
      if (row.data.maintenance) {
        if (row.data.maintenance.kind !== kind)
          throw new RepositoryError('Branch maintenance is already in progress');
        return { claim: row.data.maintenance, acquired: false };
      }
      if (row.deletion_status && kind !== 'delete')
        throw new RepositoryError('Branch deletion cannot be cancelled');
      if (row.filesystem_status === 'creating') {
        throw new RepositoryError(
          'Branch filesystem materialization is active or unsettled; wait for verified completion before maintenance'
        );
      }
      const overlap = await select(tx, { branch_id: branches.branch_id })
        .from(branches)
        .where(sql`${branches.branch_id} <> ${branchId} AND (
          ${branches.data} ->> 'path' = ${row.data.path}
          OR ${branches.data} ->> 'path' LIKE ${`${row.data.path}/%`}
          OR ${row.data.path} LIKE ((${branches.data} ->> 'path') || '/%'))`)
        .limit(1)
        .one();
      if (overlap)
        throw new RepositoryError(
          'Branch storage overlaps another branch; reconcile ownership before maintenance'
        );
      // This same Branch lock excludes new queued work and dispatch claims.
      // Deliberately a known-activity proxy, not proof of detached-process absence.
      if (await new TaskRepository(tx).hasNonterminalForBranch(branchId)) {
        throw new RepositoryError(
          'Branch has unfinished tasks; stop or cancel them before maintenance'
        );
      }
      if (
        await select(tx)
          .from(uploads)
          .where(and(eq(uploads.branch_id, branchId), eq(uploads.status, 'pending')))
          .limit(1)
          .one()
      ) {
        throw new RepositoryError(
          'Branch upload staging is active or unsettled; reconcile it before maintenance'
        );
      }
      if (
        kind === 'delete' &&
        (await select(tx)
          .from(sessions)
          .where(sql`${sessions.branch_id} = ${branchId}
        AND ${sessions.sdk_home_scope} = 'execution_home' AND (${sessions.data} ->> 'sdk_session_id') IS NOT NULL`)
          .limit(1)
          .one())
      ) {
        throw new RepositoryError(
          'Historical SDK sessions use a shared execution home; reconcile their owned storage before permanent deletion'
        );
      }
      const environment = row.data.environment_instance;
      if (
        hasActiveEnvironmentCommand(environment) ||
        (environment && ['starting', 'running', 'stopping'].includes(environment.status))
      ) {
        throw new RepositoryError('Branch environment is active; stop it before maintenance');
      }
      const claim: BranchMaintenanceClaim = {
        branch_id: branchId,
        operation_id: generateId(),
        generation: (row.data.maintenance_generation ?? 0) + 1,
        kind,
        requested_by: requestedBy,
      };
      await update(tx, branches)
        .set({
          data: { ...row.data, maintenance: claim, maintenance_generation: claim.generation },
          ...(kind === 'delete'
            ? {
                deletion_status: 'deleting' as const,
                deletion_error: null,
                deletion_updated_at: new Date(),
              }
            : {}),
        })
        .where(eq(branches.branch_id, branchId))
        .run();
      return { claim, acquired: true };
    });
  }

  /** Validate exact ownership in the same short transaction as each DB chunk. */
  async withClaim<T>(
    claim: BranchMaintenanceClaim,
    work: (db: Database, row: typeof branches.$inferSelect) => Promise<T>
  ): Promise<T> {
    return this.locked(claim.branch_id, async (tx, row) => {
      const current = this.assertClaim(row, claim);
      if (current.execution_id)
        throw new RepositoryError('Executor outcome must settle before database cleanup');
      return work(tx, row);
    });
  }

  private assertClaim(row: typeof branches.$inferSelect, claim: BranchMaintenanceClaim) {
    const current = row.data.maintenance;
    if (
      !current ||
      current.operation_id !== claim.operation_id ||
      current.generation !== claim.generation ||
      current.kind !== claim.kind
    ) {
      throw new RepositoryError('Branch maintenance ownership changed');
    }
    return current;
  }

  /**
   * Executor-driven database steps run behind the daemon's authenticated API.
   * Validate the invocation and apply one bounded DB-only step under the same
   * Branch lock. Unlike withClaim, the execution must still be active here.
   * Never await filesystem or provider work inside this callback.
   */
  async withExecution<T>(
    claim: BranchMaintenanceClaim,
    executionId: UUID,
    work: (db: Database, row: typeof branches.$inferSelect) => Promise<T>
  ): Promise<T> {
    return this.locked(claim.branch_id, async (tx, row) => {
      const current = this.assertClaim(row, claim);
      if (current.execution_id !== executionId) {
        throw new RepositoryError('Executor invocation changed');
      }
      if (!current.execution_claimed_at)
        throw new RepositoryError('Executor invocation is not claimed');
      return work(tx, row);
    });
  }

  /** Persist before dispatch; an unresolved invocation cannot be dispatched again. */
  async beginExecution(claim: BranchMaintenanceClaim): Promise<UUID> {
    return this.locked(claim.branch_id, async (tx, row) => {
      const current = this.assertClaim(row, claim);
      if (current.execution_id)
        throw new RepositoryError('Prior executor outcome requires containment reconciliation');
      const executionId = generateId();
      const requestedAt = (await this.now(tx, claim.branch_id)).toISOString();
      await update(tx, branches)
        .set({
          data: {
            ...row.data,
            maintenance: {
              ...current,
              execution_id: executionId,
              execution_requested_at: requestedAt,
              execution_claimed_at: undefined,
              execution_heartbeat_at: undefined,
            },
          },
        })
        .where(eq(branches.branch_id, claim.branch_id))
        .run();
      return executionId;
    });
  }

  /** One durable winner before any external work, even if dispatch is delivered twice. */
  async claimExecution(
    claim: BranchMaintenanceClaim,
    executionId: UUID,
    validate?: (tx: Database) => Promise<void>
  ): Promise<void> {
    await this.locked(claim.branch_id, async (tx, row) => {
      const current = this.assertClaim(row, claim);
      if (current.execution_id !== executionId)
        throw new RepositoryError('Executor invocation changed');
      if (current.execution_claimed_at)
        throw new RepositoryError('Executor invocation already claimed');
      await validate?.(tx);
      // Reconciliation may have fenced an unacknowledged dispatch. Do not start it late.
      if (row.deletion_status === 'deletion_failed')
        throw new RepositoryError('Deletion dispatch is no longer active');
      const now = (await this.now(tx, claim.branch_id)).toISOString();
      await update(tx, branches)
        .set({
          data: {
            ...row.data,
            maintenance: {
              ...current,
              execution_claimed_at: now,
              execution_heartbeat_at: now,
            },
          },
        })
        .where(eq(branches.branch_id, claim.branch_id))
        .run();
    });
  }

  /** Authenticated invocation heartbeat; never reopens failed deletion or releases ownership. */
  async heartbeatExecution(claim: BranchMaintenanceClaim, executionId: UUID): Promise<void> {
    await this.locked(claim.branch_id, async (tx, row) => {
      const current = this.assertClaim(row, claim);
      if (current.execution_id !== executionId || !current.execution_claimed_at)
        throw new RepositoryError('Executor invocation is not claimed');
      await update(tx, branches)
        .set({
          data: {
            ...row.data,
            maintenance: {
              ...current,
              execution_heartbeat_at: (await this.now(tx, claim.branch_id)).toISOString(),
            },
          },
        })
        .where(eq(branches.branch_id, claim.branch_id))
        .run();
    });
  }

  /**
   * Observation only. A stale heartbeat is not containment evidence and must
   * never release this invocation or authorize a replacement executor.
   * Recheck under the Branch lock so a concurrent heartbeat wins correctly.
   */
  async markStaleDeletion(claim: BranchMaintenanceClaim, staleAfterMs: number): Promise<boolean> {
    if (!Number.isFinite(staleAfterMs) || staleAfterMs <= 0)
      throw new RepositoryError('Invalid heartbeat threshold');
    return this.locked(claim.branch_id, async (tx, row) => {
      const current = this.assertClaim(row, claim);
      if (current.kind !== 'delete' || row.deletion_status !== 'deleting') return false;
      const last =
        current.execution_heartbeat_at ??
        current.execution_requested_at ??
        row.deletion_updated_at?.toISOString();
      const now = await this.now(tx, claim.branch_id);
      if (
        last &&
        Number.isFinite(Date.parse(last)) &&
        now.getTime() - Date.parse(last) < staleAfterMs
      )
        return false;
      await update(tx, branches)
        .set({
          deletion_status: 'deletion_failed',
          deletion_error: current.execution_id
            ? 'Deletion executor stopped reporting; its outcome is unknown. Reconciliation is required before retry.'
            : 'Deletion was interrupted before executor admission. Retry permanent deletion to continue.',
          // No invocation was ever admitted: there can be no late claimant.
          ...(!current.execution_id ? { data: { ...row.data, maintenance: undefined } } : {}),
          deletion_updated_at: now,
        })
        .where(eq(branches.branch_id, claim.branch_id))
        .run();
      return true;
    });
  }

  /** Only the contained-executor owner may call this after verified settlement. */
  async settleExecution(claim: BranchMaintenanceClaim, executionId: UUID): Promise<void> {
    await this.locked(claim.branch_id, async (tx, row) => {
      const current = this.assertClaim(row, claim);
      if (current.execution_id !== executionId)
        throw new RepositoryError('Executor invocation changed');
      await update(tx, branches)
        .set({
          data: {
            ...row.data,
            maintenance: {
              ...current,
              execution_id: undefined,
              execution_requested_at: undefined,
              execution_claimed_at: undefined,
              execution_heartbeat_at: undefined,
            },
          },
        })
        .where(eq(branches.branch_id, claim.branch_id))
        .run();
    });
  }

  /** Non-deletion maintenance releases only after its executor has settled. */
  async release(claim: BranchMaintenanceClaim): Promise<void> {
    await this.locked(claim.branch_id, async (tx, row) => {
      const current = this.assertClaim(row, claim);
      if (claim.kind === 'delete' || row.deletion_status) {
        throw new RepositoryError('Branch deletion cannot be cancelled');
      }
      if (current.execution_id) {
        throw new RepositoryError(
          'Executor containment must be verified before releasing maintenance'
        );
      }
      await update(tx, branches)
        .set({ data: { ...row.data, maintenance: undefined } })
        .where(eq(branches.branch_id, claim.branch_id))
        .run();
    });
  }

  /** Safe summaries only. Unknown effects retain ownership; settled failures can retry. */
  async fail(claim: BranchMaintenanceClaim, safeSummary: string): Promise<void> {
    await this.locked(claim.branch_id, async (tx, row) => {
      const current = this.assertClaim(row, claim);
      await update(tx, branches)
        .set({
          data: { ...row.data, maintenance: current.execution_id ? current : undefined },
          ...(claim.kind === 'delete'
            ? {
                deletion_status: 'deletion_failed' as const,
                deletion_error: safeSummary.slice(0, 500),
                deletion_updated_at: new Date(),
              }
            : {}),
        })
        .where(eq(branches.branch_id, claim.branch_id))
        .run();
    });
  }
}

/** Routing-only queries; caller supplies tenant scope or the narrow system discovery capability. */
export class BranchMaintenanceDiscoveryRepository {
  constructor(private readonly db: Database) {}

  async findDeletingRefs(options: {
    tenantId?: string;
    after?: BranchMaintenanceRoutingRef;
  }): Promise<BranchMaintenanceRoutingRef[]> {
    if (!options.tenantId && !isPostgresDatabase(this.db)) {
      throw new RepositoryError('Cross-tenant maintenance discovery requires PostgreSQL');
    }
    const after = options.after;
    const rows = rawRows(
      await executeRaw(
        this.db,
        options.tenantId
          ? sql`SELECT branch_id, ${options.tenantId} AS tenant_id FROM branches
          WHERE deletion_status = 'deleting' AND branch_id > ${after?.branch_id ?? ''}
          ORDER BY branch_id LIMIT ${BRANCH_MAINTENANCE_DISCOVERY_PAGE_SIZE}`
          : sql`SELECT branch_id, tenant_id FROM branches WHERE deletion_status = 'deleting'
          AND (tenant_id, branch_id) > (${after?.tenant_id ?? ''}, ${after?.branch_id ?? ''})
          ORDER BY tenant_id, branch_id LIMIT ${BRANCH_MAINTENANCE_DISCOVERY_PAGE_SIZE}`
      )
    );
    return rows.map((row) => ({
      tenant_id: String(row.tenant_id) as TenantID,
      branch_id: String(row.branch_id) as BranchID,
    }));
  }
}
