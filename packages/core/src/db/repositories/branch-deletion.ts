import { eq, sql } from 'drizzle-orm';
import {
  type BranchID,
  type BranchMaintenanceClaim,
  branchDeletionCommandId,
  type UUID,
} from '../../types';
import { deleteBranchDataBatch } from '../branch-deletion-data';
import { reconcileBranchDeletionReferencesBatch } from '../branch-deletion-references';
import { lockBranchReferenceMutation } from '../branch-reference-admission';
import type { Database } from '../client';
import {
  deleteFrom,
  executeRaw,
  isPostgresDatabase,
  rawRows,
  runDatabaseTransaction,
  update,
} from '../database-wrapper';
import { branches } from '../schema';
import { RepositoryError } from './base';
import { BranchMaintenanceRepository } from './branch-maintenance';

/** Deletion-specific steps; shared maintenance owns admission and invocation fencing. */
export class BranchDeletionRepository {
  constructor(private readonly db: Database) {}

  private step<T>(
    claim: BranchMaintenanceClaim,
    invocation: UUID,
    work: (tx: Database, row: typeof branches.$inferSelect) => Promise<T>
  ) {
    if (claim.kind !== 'delete') throw new RepositoryError('A deletion claim is required');
    return new BranchMaintenanceRepository(this.db).withExecution(
      claim,
      invocation,
      async (tx, row) => {
        if (!row.deletion_status) throw new RepositoryError('Branch deletion is not active');
        return work(tx, row);
      }
    );
  }

  /** Lock before the subject Branch: two pages must not lock A→B and B→A. */
  private referenceStep<T>(
    claim: BranchMaintenanceClaim,
    invocation: UUID,
    work: (tx: Database, row: typeof branches.$inferSelect) => Promise<T>
  ): Promise<T> {
    return runDatabaseTransaction(
      this.db,
      async (tx) => {
        await lockBranchReferenceMutation(tx);
        return new BranchDeletionRepository(tx).step(claim, invocation, work);
      },
      { sqliteImmediate: true, sqliteBusyRetries: 9 }
    );
  }

  private async reconcileReferencesPage(
    tx: Database,
    row: typeof branches.$inferSelect
  ): Promise<boolean> {
    const current = row.data.maintenance!;
    if (!current.references_done) {
      const page = await reconcileBranchDeletionReferencesBatch(
        tx,
        row.branch_id as BranchID,
        current.reference_cursor
      );
      await update(tx, branches)
        .set({
          data: {
            ...row.data,
            maintenance: {
              ...current,
              reference_cursor: page.cursor,
              references_done: page.done,
            },
          },
        })
        .where(eq(branches.branch_id, row.branch_id))
        .run();
      return true;
    }
    return false;
  }

  async quiescePage(
    claim: BranchMaintenanceClaim,
    invocation: UUID
  ): Promise<{ remaining: boolean }> {
    return this.referenceStep(claim, invocation, async (tx, row) => {
      // Disable durable producers in bounded pages before touching storage.
      for (const [table, key, owner] of [
        ['schedules', 'schedule_id', 'branch_id'],
        ['gateway_channels', 'id', 'target_branch_id'],
      ] as const) {
        const changed = rawRows(
          await executeRaw(
            tx,
            sql`UPDATE ${sql.identifier(table)} SET enabled = false
          WHERE ${sql.identifier(key)} IN (SELECT ${sql.identifier(key)} FROM ${sql.identifier(table)}
          WHERE ${sql.identifier(owner)} = ${claim.branch_id} AND enabled = true
          ORDER BY ${sql.identifier(key)} LIMIT 100) RETURNING ${sql.identifier(key)}`
          )
        );
        if (changed.length) return { remaining: true };
      }
      // Resolve dependency blockers while locator rows and files still exist.
      return { remaining: await this.reconcileReferencesPage(tx, row) };
    });
  }

  async verifyStorage(claim: BranchMaintenanceClaim, invocation: UUID): Promise<void> {
    await this.step(claim, invocation, async (tx, row) => {
      await update(tx, branches)
        .set({
          data: { ...row.data, maintenance: { ...row.data.maintenance!, storage_verified: true } },
        })
        .where(eq(branches.branch_id, claim.branch_id))
        .run();
    });
  }

  async failSettled(
    claim: BranchMaintenanceClaim,
    invocation: UUID,
    safeSummary: string
  ): Promise<void> {
    await this.step(claim, invocation, async (tx, row) => {
      await update(tx, branches)
        .set({
          data: { ...row.data, maintenance: undefined },
          deletion_status: 'deletion_failed',
          deletion_error: safeSummary.slice(0, 500),
          deletion_updated_at: new Date(),
        })
        .where(eq(branches.branch_id, claim.branch_id))
        .run();
    });
  }

  async deleteDataPage(
    claim: BranchMaintenanceClaim,
    invocation: UUID
  ): Promise<{ remaining: boolean }> {
    return this.referenceStep(claim, invocation, async (tx, row) => {
      const current = row.data.maintenance!;
      if (!current.storage_verified)
        throw new RepositoryError('Required storage removal has not been verified');
      if (await this.reconcileReferencesPage(tx, row)) return { remaining: true };
      const page = await deleteBranchDataBatch(
        tx,
        claim.branch_id,
        branchDeletionCommandId(invocation)
      );
      if (!page.remaining) {
        await update(tx, branches)
          .set({ data: { ...row.data, maintenance: { ...current, data_done: true } } })
          .where(eq(branches.branch_id, claim.branch_id))
          .run();
      }
      return { remaining: page.remaining };
    });
  }

  async finalize(
    claim: BranchMaintenanceClaim,
    invocation: UUID,
    beforeRemove: (tx: Database) => Promise<void>
  ): Promise<void> {
    await this.step(claim, invocation, async (tx, row) => {
      const current = row.data.maintenance!;
      if (!current.storage_verified || !current.references_done || !current.data_done) {
        throw new RepositoryError('Required deletion steps have not completed');
      }
      // Requery authoritative rows, not just a cached "done" marker. Any newly
      // observed work rolls this entire transaction back for a bounded retry.
      if (
        (await deleteBranchDataBatch(tx, claim.branch_id, branchDeletionCommandId(invocation)))
          .remaining
      ) {
        throw new RepositoryError(
          'Owned resources remain; continue bounded deletion before finalizing'
        );
      }
      const counts = rawRows(
        await executeRaw(
          tx,
          sql`SELECT
        (SELECT count(*) FROM branch_owners WHERE branch_id = ${claim.branch_id}) +
        (SELECT count(*) FROM branch_group_grants WHERE branch_id = ${claim.branch_id}) +
        (SELECT count(*) FROM board_objects WHERE branch_id = ${claim.branch_id}) +
        (SELECT count(*) FROM branch_permission_entries WHERE config_id IN
          (SELECT config_id FROM branch_permission_configs WHERE branch_id = ${claim.branch_id})) AS n`
        )
      );
      if (Number(counts[0]?.n ?? 0) > 100) {
        throw new RepositoryError(
          'Branch authorization/placement inventory exceeds the bounded finalization limit'
        );
      }
      await beforeRemove(tx); // capture authorization for post-commit realtime before cascading policies
      const now = isPostgresDatabase(tx) ? sql`clock_timestamp()` : sql`${Date.now()}`;
      await executeRaw(
        tx,
        sql`UPDATE executor_session_token_authorities SET revoked_at = ${now}
        WHERE session_id = ${branchDeletionCommandId(invocation)} AND revoked_at IS NULL`
      );
      // This must remain the last destructive statement. No filesystem cleanup
      // or required descendant removal is deferred beyond this commit.
      await deleteFrom(tx, branches).where(eq(branches.branch_id, claim.branch_id)).run();
    });
  }
}
