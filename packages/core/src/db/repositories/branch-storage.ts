import { and, eq, inArray } from 'drizzle-orm';
import { generateId } from '../../lib/ids';
import type {
  BranchBundleReceipt,
  BranchID,
  BranchStoragePhase,
  BranchStorageRecord,
} from '../../types';
import {
  EXECUTING_TASK_STATUSES,
  hasActiveEnvironmentCommand,
  isBranchBundleReceipt,
} from '../../types';
import type { Database } from '../client';
import {
  isSQLiteDatabase,
  lockRowForUpdate,
  runDatabaseTransaction,
  select,
  update,
} from '../database-wrapper';
import { branches, sessions, tasks } from '../schema';
import { EntityNotFoundError, RepositoryError } from './base';

/** Residency and short FS admissions share the existing tenant-owned branch lock. */
export class BranchStorageRepository {
  constructor(private readonly db: Database) {}

  private async mutate<T>(
    id: BranchID,
    work: (
      record: BranchStorageRecord,
      row: typeof branches.$inferSelect,
      tx: Database
    ) => Promise<{ record: BranchStorageRecord; value: T }>
  ): Promise<T> {
    for (let retry = 0; ; retry++) {
      try {
        return await runDatabaseTransaction(
          this.db,
          async (tx) => {
            await lockRowForUpdate(tx, this.db, branches, eq(branches.branch_id, id));
            const row = await select(tx).from(branches).where(eq(branches.branch_id, id)).one();
            if (!row) throw new EntityNotFoundError('Branch', id);
            const result = await work(row.workspace_storage ?? { residency: 'warm' }, row, tx);
            await update(tx, branches)
              .set({ workspace_storage: result.record, updated_at: new Date() })
              .where(eq(branches.branch_id, id))
              .run();
            return result.value;
          },
          { sqliteImmediate: true }
        );
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

  async get(id: BranchID): Promise<BranchStorageRecord> {
    const row = await select(this.db).from(branches).where(eq(branches.branch_id, id)).one();
    if (!row) throw new EntityNotFoundError('Branch', id);
    return row.workspace_storage ?? { residency: 'warm' };
  }

  /** Retained until completion; a lost completion refuses cooling, never assumes idle. */
  async admitFilesystem(id: BranchID): Promise<string> {
    return this.mutate(id, async (record) => {
      if (record.residency !== 'warm')
        throw new RepositoryError('Restore the workspace before accessing branch files');
      const admission = generateId();
      return {
        record: { ...record, admissions: [...(record.admissions ?? []), admission] },
        value: admission,
      };
    });
  }

  async releaseFilesystem(id: BranchID, admission: string): Promise<void> {
    return this.mutate(id, async (record) => ({
      record: { ...record, admissions: record.admissions?.filter((entry) => entry !== admission) },
      value: undefined,
    }));
  }

  async beginCooling(id: BranchID): Promise<BranchStorageRecord> {
    return this.mutate(id, async (record, row, tx) => {
      if (record.residency !== 'warm')
        throw new RepositoryError('A workspace storage operation already exists');
      if (record.admissions?.length)
        throw new RepositoryError('Branch filesystem operations are still active or unresolved');
      if (
        row.storage_mode !== 'clone' ||
        (row.filesystem_status && !['ready', 'preserved'].includes(row.filesystem_status))
      ) {
        throw new RepositoryError('Cold storage requires a ready, self-contained clone');
      }
      const executing = await select(tx, { task_id: tasks.task_id })
        .from(tasks)
        .innerJoin(sessions, eq(tasks.session_id, sessions.session_id))
        .where(and(eq(sessions.branch_id, id), inArray(tasks.status, [...EXECUTING_TASK_STATUSES])))
        .limit(1)
        .one();
      const environment = row.data.environment_instance;
      if (
        executing ||
        hasActiveEnvironmentCommand(environment) ||
        (environment && environment.status !== 'stopped')
      ) {
        throw new RepositoryError(
          'Finish running tasks and stop the environment before moving this branch to cold storage'
        );
      }
      const next: BranchStorageRecord = {
        residency: 'cooling',
        operationId: generateId(),
        phase: 'packing',
        startedAt: new Date().toISOString(),
      };
      return { record: next, value: next };
    });
  }

  async saveReceipt(
    id: BranchID,
    operationId: string,
    receipt: BranchBundleReceipt
  ): Promise<BranchStorageRecord> {
    if (!isBranchBundleReceipt(receipt))
      throw new RepositoryError('Verified bundle receipt is invalid');
    return this.advance(id, operationId, 'packing', (record) => ({
      ...record,
      receipt,
      phase: 'cleanup',
    }));
  }

  async finishCooling(id: BranchID, operationId: string): Promise<BranchStorageRecord> {
    return this.advance(id, operationId, 'cleanup', (record) => {
      if (!record.receipt)
        throw new RepositoryError('Verified bundle receipt is required before cleanup');
      return { ...record, residency: 'cold', phase: 'stored', error: undefined };
    });
  }

  async beginRestore(id: BranchID): Promise<BranchStorageRecord> {
    return this.mutate(id, async (record) => {
      if ((record.residency !== 'cold' && !record.retryable) || !record.receipt)
        throw new RepositoryError('Workspace is not ready for restore');
      const next: BranchStorageRecord = {
        ...record,
        residency: 'warming',
        operationId: generateId(),
        phase: 'restoring',
        startedAt: new Date().toISOString(),
        error: undefined,
        replacePartial: record.residency !== 'cold',
        retryable: false,
      };
      return { record: next, value: next };
    });
  }

  async markPublishing(id: BranchID, operationId: string): Promise<BranchStorageRecord> {
    return this.advance(id, operationId, 'restoring', (record) => ({
      ...record,
      phase: 'publishing',
    }));
  }

  async finishRestore(id: BranchID, operationId: string): Promise<BranchStorageRecord> {
    return this.advance(id, operationId, 'publishing', (record) => ({
      ...record,
      residency: 'warm',
      phase: 'ready',
      error: undefined,
    }));
  }

  /** Only a failed pre-cleanup pack may return to warm. All uncertain FS phases stay closed. */
  async fail(
    id: BranchID,
    operationId: string,
    phase: BranchStoragePhase,
    error: string,
    retryable = false
  ): Promise<BranchStorageRecord> {
    return this.advance(id, operationId, phase, (record) => ({
      ...record,
      residency: phase === 'packing' && !record.receipt ? 'warm' : record.residency,
      error: error.slice(0, 500),
      retryable: retryable && !!record.receipt,
    }));
  }

  private async advance(
    id: BranchID,
    operationId: string,
    phase: BranchStoragePhase,
    change: (record: BranchStorageRecord) => BranchStorageRecord
  ): Promise<BranchStorageRecord> {
    return this.mutate(id, async (record) => {
      if (record.operationId !== operationId || record.phase !== phase)
        throw new RepositoryError('Workspace storage operation changed');
      const next = change(record);
      return { record: next, value: next };
    });
  }
}
