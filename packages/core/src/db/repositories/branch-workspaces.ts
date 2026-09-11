import { eq, sql } from 'drizzle-orm';
import type { WorkspaceMetadata, WorkspaceScope, WorkspaceState } from '../../workspaces/types';
import { WorkspaceError } from '../../workspaces/types';
import type { Database } from '../client';
import {
  isPostgresDatabase,
  isSQLiteDatabase,
  lockRowForUpdate,
  runDatabaseTransaction,
  select,
  update,
} from '../database-wrapper';
import { branches } from '../schema';
import { getCurrentTenantId, runWithTenantDatabaseScope } from '../tenant-scope';
import { assertTenantWritable } from '../tenant-write-gate';

/** Existing branch row owns the state: existing RLS, deletion and portability apply. */
export class BranchWorkspaceRepository implements WorkspaceMetadata {
  constructor(
    private readonly db: Database,
    private readonly scope: WorkspaceScope
  ) {}
  private assertTenant() {
    if (String(getCurrentTenantId() ?? '') !== this.scope.tenantId)
      throw new WorkspaceError('INVALID', 'Workspace tenant context mismatch');
  }
  private async load(db: Database) {
    const now = isPostgresDatabase(db)
      ? sql<number>`floor(extract(epoch from clock_timestamp()) * 1000)`
      : sql<number>`cast((julianday('now') - 2440587.5) * 86400000 as integer)`;
    const row = await select(db, { state: branches.workspace_state, now })
      .from(branches)
      .where(eq(branches.branch_id, this.scope.branchId))
      .one();
    if (!row) throw new WorkspaceError('INVALID', 'Workspace branch not found');
    if (
      row.state &&
      (row.state.scope.tenantId !== this.scope.tenantId ||
        row.state.scope.branchId !== this.scope.branchId)
    )
      throw new WorkspaceError('INVALID', 'Workspace scope mismatch');
    return { state: row.state, now: Number(row.now) };
  }
  async read() {
    this.assertTenant();
    return runWithTenantDatabaseScope(this.db, this.scope.tenantId, (db) => this.load(db));
  }
  async mutate<T>(
    work: (state: WorkspaceState | null, now: number) => { state: WorkspaceState; result: T }
  ): Promise<T> {
    this.assertTenant();
    const transaction = () =>
      runWithTenantDatabaseScope(this.db, this.scope.tenantId, (scoped) =>
        runDatabaseTransaction(
          scoped,
          async (tx) => {
            await assertTenantWritable(tx, this.scope.tenantId);
            await lockRowForUpdate(
              tx,
              this.db,
              branches,
              eq(branches.branch_id, this.scope.branchId)
            );
            const { state, now } = await this.load(tx);
            const next = work(state, now);
            if (
              next.state.scope.tenantId !== this.scope.tenantId ||
              next.state.scope.branchId !== this.scope.branchId
            )
              throw new WorkspaceError('INVALID', 'Workspace scope cannot change');
            await update(tx, branches)
              .set({ workspace_state: next.state })
              .where(eq(branches.branch_id, this.scope.branchId))
              .run();
            return next.result;
          },
          { sqliteImmediate: true }
        )
      );
    // Retry only rolled-back metadata contention, never tool execution or blob publication.
    for (let retry = 0; ; retry++) {
      try {
        return await transaction();
      } catch (error) {
        if (
          !isSQLiteDatabase(this.db) ||
          !/SQLITE_BUSY|database is locked/i.test(String(error)) ||
          retry >= 9
        )
          throw error;
        await new Promise((resolve) => setTimeout(resolve, 10 * (retry + 1)));
      }
    }
  }
}
