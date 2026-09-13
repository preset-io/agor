import { and, asc, eq, gt, inArray, type SQL, sql } from 'drizzle-orm';
import { generateId } from '../../lib/ids';
import {
  BRANCH_DELETION_ERRORS,
  type BranchDeletionOperationID,
  type BranchDeletionOperationRef,
  type BranchDeletionReceipt,
  type BranchDeletionResource,
  type BranchDeletionResourceIdentity,
  type BranchID,
  type UserID,
  type UUID,
} from '../../types';
import type { Database } from '../client';
import {
  insert,
  isPostgresDatabase,
  lockRowForUpdate,
  runDatabaseTransaction,
  select,
  update,
} from '../database-wrapper';
import {
  branches,
  branchDeletionOperations as operations,
  branchDeletionResources as resources,
} from '../schema';
import * as pg from '../schema.postgres';
import { requireCurrentTenantId } from '../tenant-context';
import { assertTenantWritable } from '../tenant-write-gate';
import { RepositoryError } from './base';

const PAGE_LIMIT = 200;

function limitPage(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > PAGE_LIMIT) {
    throw new RepositoryError(`Deletion ledger page size must be between 1 and ${PAGE_LIMIT}`);
  }
  return limit;
}

function assertTenant(ref: BranchDeletionOperationRef): void {
  if (requireCurrentTenantId() !== ref.tenant_id) {
    throw new RepositoryError('Deletion operation tenant does not match trusted context');
  }
}

function operationWhere(db: Database, ref: BranchDeletionOperationRef) {
  assertTenant(ref);
  return and(
    isPostgresDatabase(db) ? eq(pg.branchDeletionOperations.tenant_id, ref.tenant_id) : undefined,
    eq(operations.branch_id, ref.branch_id),
    eq(operations.operation_id, ref.operation_id)
  ) as SQL;
}

function resourceWhere(db: Database, ref: BranchDeletionOperationRef, resourceId?: string) {
  assertTenant(ref);
  return and(
    isPostgresDatabase(db) ? eq(pg.branchDeletionResources.tenant_id, ref.tenant_id) : undefined,
    eq(resources.operation_id, ref.operation_id),
    resourceId === undefined ? undefined : eq(resources.resource_id, resourceId)
  );
}

function receipt(row: typeof operations.$inferSelect): BranchDeletionReceipt {
  return {
    operation_id: row.operation_id as BranchDeletionOperationID,
    branch_id: row.branch_id as BranchID,
    requested_by: row.requested_by as UserID,
    confirmed_at: row.confirmed_at.toISOString(),
    status: row.status,
    stage: row.stage,
    updated_at: row.updated_at.toISOString(),
    completed_at: row.completed_at?.toISOString() ?? null,
    error_code: row.error_code,
  };
}

/**
 * Private persistence for deletion checkpoints, NOT branch maintenance admission
 * or executor supervision. The caller must authorize and fence the branch using
 * the lifecycle owner before recording acceptance. No filesystem/network work
 * runs in these short units. Resource identities cannot change on replay, and an
 * uncertain invocation cannot become pending merely because a lease expired.
 *
 * This repository intentionally has no branch-delete or operation-complete
 * method: those require the authoritative final inventory and lifecycle fence,
 * not merely an empty ledger. Do not expose it as generic CRUD.
 */
export class BranchDeletionRepository {
  constructor(private readonly db: Database) {}

  /** Call inside the same short transaction as authorized maintenance admission. */
  async recordRequest(branchId: BranchID, actorId: UserID): Promise<BranchDeletionReceipt> {
    const tenantId = requireCurrentTenantId();
    return runDatabaseTransaction(
      this.db,
      async (tx) => {
        await assertTenantWritable(tx, tenantId);
        await lockRowForUpdate(tx, this.db, branches, eq(branches.branch_id, branchId));
        const branch = await select(tx)
          .from(branches)
          .where(eq(branches.branch_id, branchId))
          .one();
        if (!branch) throw new RepositoryError('Deletion branch not found');
        const existing = await select(tx)
          .from(operations)
          .where(
            and(
              isPostgresDatabase(this.db)
                ? eq(pg.branchDeletionOperations.tenant_id, tenantId)
                : undefined,
              eq(operations.branch_id, branchId)
            )
          )
          .one();
        if (existing) return receipt(existing);
        const now = new Date();
        const row = await insert(tx, operations)
          .values({
            operation_id: generateId(),
            ...(isPostgresDatabase(this.db) ? { tenant_id: tenantId } : {}),
            branch_id: branchId,
            requested_by: actorId,
            confirmed_at: now,
            updated_at: now,
            status: 'pending',
            stage: 'requested',
            revision: 0,
            inventory_sealed: false,
          })
          .returning()
          .one();
        return receipt(row);
      },
      { sqliteImmediate: true }
    );
  }

  async get(ref: BranchDeletionOperationRef): Promise<BranchDeletionReceipt | null> {
    const row = await select(this.db).from(operations).where(operationWhere(this.db, ref)).one();
    return row ? receipt(row) : null;
  }

  private async withOperation<T>(
    ref: BranchDeletionOperationRef,
    work: (tx: Database, row: typeof operations.$inferSelect) => Promise<T>
  ): Promise<T> {
    const where = operationWhere(this.db, ref);
    return runDatabaseTransaction(
      this.db,
      async (tx) => {
        await assertTenantWritable(tx, ref.tenant_id);
        await lockRowForUpdate(tx, this.db, operations, where);
        const row = await select(tx).from(operations).where(where).one();
        if (!row || row.status === 'completed')
          throw new RepositoryError('Deletion operation is unavailable');
        return work(tx, row);
      },
      { sqliteImmediate: true }
    );
  }

  /** One bounded inventory page, persisted before deleting any lookup rows. */
  async inventory(
    ref: BranchDeletionOperationRef,
    page: readonly BranchDeletionResourceIdentity[]
  ): Promise<void> {
    limitPage(page.length);
    for (const resource of page) {
      for (const value of [
        resource.resource_id,
        resource.owner,
        resource.locator,
        resource.version,
      ]) {
        if (
          !value ||
          value.length > 4096 ||
          Array.from(value).some((char) => char.charCodeAt(0) < 32)
        )
          throw new RepositoryError('Invalid deletion resource identity');
      }
    }
    await this.withOperation(ref, async (tx, operation) => {
      if (operation.inventory_sealed) throw new RepositoryError('Deletion inventory is sealed');
      for (const resource of page) {
        const existing = await select(tx)
          .from(resources)
          .where(resourceWhere(this.db, ref, resource.resource_id))
          .one();
        if (existing) {
          if (
            existing.kind !== resource.kind ||
            existing.owner !== resource.owner ||
            existing.locator !== resource.locator ||
            existing.version !== resource.version
          ) {
            throw new RepositoryError(BRANCH_DELETION_ERRORS.inventory_changed);
          }
          continue;
        }
        await insert(tx, resources)
          .values({
            ...resource,
            ...(isPostgresDatabase(this.db) ? { tenant_id: ref.tenant_id } : {}),
            operation_id: ref.operation_id,
            state: 'pending',
          })
          .run();
      }
      await update(tx, operations)
        .set({ updated_at: new Date(), revision: sql`${operations.revision} + 1` })
        .where(operationWhere(this.db, ref))
        .run();
    });
  }

  async listResources(
    ref: BranchDeletionOperationRef,
    options: { after?: string; limit?: number } = {}
  ): Promise<BranchDeletionResource[]> {
    if (!(await this.get(ref))) throw new RepositoryError('Deletion operation is unavailable');
    const rows = await select(this.db)
      .from(resources)
      .where(
        and(
          resourceWhere(this.db, ref),
          options.after ? gt(resources.resource_id, options.after) : undefined
        )
      )
      .orderBy(asc(resources.resource_id))
      .limit(limitPage(options.limit ?? PAGE_LIMIT))
      .all();
    return rows.map((row: typeof resources.$inferSelect) => ({
      resource_id: row.resource_id,
      kind: row.kind,
      owner: row.owner,
      locator: row.locator,
      version: row.version,
      state: row.state,
      retention_reason: row.retention_reason,
      invocation_id: row.invocation_id as UUID | null,
    }));
  }

  /** Seal only after the lifecycle owner has verified quiescence and full inventory. */
  async sealInventory(ref: BranchDeletionOperationRef): Promise<void> {
    await this.withOperation(ref, async (tx) => {
      await update(tx, operations)
        .set({
          inventory_sealed: true,
          updated_at: new Date(),
          revision: sql`${operations.revision} + 1`,
        })
        .where(operationWhere(this.db, ref))
        .run();
    });
  }

  /** Persist before dispatch. A duplicate or uncertain invocation is never relaunched. */
  async beginInvocation(
    ref: BranchDeletionOperationRef,
    resourceId: string,
    invocationId: UUID
  ): Promise<void> {
    await this.withOperation(ref, async (tx, operation) => {
      if (!operation.inventory_sealed)
        throw new RepositoryError('Deletion inventory is not sealed');
      const result = await update(tx, resources)
        .set({ state: 'in_flight', invocation_id: invocationId })
        .where(and(resourceWhere(this.db, ref, resourceId), eq(resources.state, 'pending')))
        .run();
      if (result.rowsAffected !== 1)
        throw new RepositoryError(BRANCH_DELETION_ERRORS.invocation_unsettled);
    });
  }

  /** The storage owner must have verified removal at this exact locator/version. */
  async confirmRemoval(
    ref: BranchDeletionOperationRef,
    resourceId: string,
    invocationId: UUID
  ): Promise<void> {
    await this.withOperation(ref, async (tx) => {
      const result = await update(tx, resources)
        .set({ state: 'removed' })
        .where(
          and(
            resourceWhere(this.db, ref, resourceId),
            eq(resources.invocation_id, invocationId),
            inArray(resources.state, ['in_flight', 'removed'])
          )
        )
        .run();
      if (result.rowsAffected !== 1)
        throw new RepositoryError(BRANCH_DELETION_ERRORS.invocation_unsettled);
    });
  }
}
