import { eq, sql } from 'drizzle-orm';
import type { DistributedWorkIdentity } from '../../coordination';
import { validateEnvironmentSourceRevision } from '../../environment/lifecycle-result';
import type { BranchEnvironmentInstance, BranchID, UserID } from '../../types';
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
import { EntityNotFoundError, RepositoryError } from './base';

const SYNC_ERROR_MAX_CHARS = 2_048;
const SYNC_RETRY_MIN_MS = 5_000;
const SYNC_RETRY_MAX_MS = 5 * 60_000;

type SourceSyncState = NonNullable<BranchEnvironmentInstance['source_sync']>;
type SourceSyncAttempt = NonNullable<SourceSyncState['active_attempt']>;

export type EnvironmentSyncRequestResult = {
  changed: boolean;
  state: SourceSyncState;
};

export type EnvironmentSyncClaimResult =
  | { outcome: 'claimed'; attempt: SourceSyncAttempt }
  | { outcome: 'held'; lease_expires_at: string }
  | { outcome: 'not_due'; retry_at: string }
  | { outcome: 'up_to_date' }
  | { outcome: 'unavailable' };

export type EnvironmentSyncSettlementResult =
  | { outcome: 'stale' }
  | {
      outcome: 'settled';
      desired_revision: string;
      applied_revision?: string;
      needs_reconcile: boolean;
    };

function sanitizeSyncError(message: string): string {
  const withoutControls = Array.from(message, (character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127 ? ' ' : character;
  }).join('');
  const normalized = withoutControls.replace(/\s+/g, ' ').trim();
  return (normalized || 'Source synchronization failed').slice(0, SYNC_ERROR_MAX_CHARS);
}

function retryDelayMs(failureCount: number): number {
  return Math.min(
    SYNC_RETRY_MIN_MS * 2 ** Math.min(16, Math.max(0, failureCount - 1)),
    SYNC_RETRY_MAX_MS
  );
}

function isSQLiteBusyError(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  if (/SQLITE_BUSY|database is locked|database is busy/i.test(text)) return true;
  return error instanceof Error && 'cause' in error && isSQLiteBusyError(error.cause);
}

/** Tenant-scoped desired/applied source reconciliation with one durable claim. */
export class EnvironmentSyncRepository {
  constructor(private readonly db: Database) {}

  /** Retry the whole SQLite transaction so a contending writer re-reads durable state. */
  private async runMutation<T>(mutation: () => Promise<T>, attempt = 0): Promise<T> {
    try {
      return await mutation();
    } catch (error) {
      // libSQL may report write contention immediately despite busy_timeout.
      if (isSQLiteDatabase(this.db) && attempt < 9 && isSQLiteBusyError(error)) {
        await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)));
        return this.runMutation(mutation, attempt + 1);
      }
      throw error;
    }
  }

  private async mutationNow(txDb: Database, branchId: BranchID): Promise<Date> {
    if (!isPostgresDatabase(this.db)) return new Date();
    const row = await select(txDb, { value: sql<Date>`clock_timestamp()` })
      .from(branches)
      .where(eq(branches.branch_id, branchId))
      .one();
    if (!row) throw new EntityNotFoundError('Branch', branchId);
    return row.value instanceof Date ? row.value : new Date(row.value);
  }

  async request(input: {
    branchId: BranchID;
    desiredRevision: string;
    requestedByUserId?: UserID;
  }): Promise<EnvironmentSyncRequestResult> {
    const desiredRevision = validateEnvironmentSourceRevision(input.desiredRevision);
    return this.runMutation(() =>
      runDatabaseTransaction(
        this.db,
        async (txDb) => {
          await lockRowForUpdate(txDb, this.db, branches, eq(branches.branch_id, input.branchId));
          const row = await select(txDb)
            .from(branches)
            .where(eq(branches.branch_id, input.branchId))
            .one();
          if (!row || row.archived) throw new EntityNotFoundError('Branch', input.branchId);
          const now = await this.mutationNow(txDb, input.branchId);
          const data = row.data as {
            environment_instance?: BranchEnvironmentInstance;
            [key: string]: unknown;
          };
          const environment = data.environment_instance ?? { status: 'stopped' as const };
          const current = environment.source_sync;
          const changed = current?.desired_revision !== desiredRevision;
          const state: SourceSyncState = {
            desired_revision: desiredRevision,
            desired_at: changed ? now.toISOString() : (current?.desired_at ?? now.toISOString()),
            ...(current?.applied_revision
              ? { applied_revision: current.applied_revision, applied_at: current.applied_at }
              : {}),
            ...(input.requestedByUserId
              ? { requested_by_user_id: input.requestedByUserId }
              : current?.requested_by_user_id
                ? { requested_by_user_id: current.requested_by_user_id }
                : {}),
            ...(current?.active_attempt ? { active_attempt: current.active_attempt } : {}),
            ...(!changed && current?.last_error ? { last_error: current.last_error } : {}),
            ...(!changed && current?.failure_count ? { failure_count: current.failure_count } : {}),
            ...(!changed && current?.retry_not_before_at
              ? { retry_not_before_at: current.retry_not_before_at }
              : {}),
          };
          if (changed || input.requestedByUserId !== current?.requested_by_user_id) {
            await update(txDb, branches)
              .set({
                data: {
                  ...data,
                  environment_instance: { ...environment, source_sync: state },
                },
                updated_at: now,
              })
              .where(eq(branches.branch_id, input.branchId))
              .run();
          }
          return { changed, state };
        },
        { sqliteImmediate: true }
      )
    );
  }

  async claim(input: {
    branchId: BranchID;
    claimToken: string;
    leaseDurationMs: number;
    identity: DistributedWorkIdentity;
  }): Promise<EnvironmentSyncClaimResult> {
    if (!input.claimToken.trim())
      throw new RepositoryError('Environment sync claim token required');
    if (!input.identity.instanceId.trim() || !input.identity.bootId.trim()) {
      throw new RepositoryError('Environment sync identity required');
    }
    if (!Number.isSafeInteger(input.leaseDurationMs) || input.leaseDurationMs <= 0) {
      throw new RepositoryError('Environment sync lease must be a positive integer');
    }
    return this.runMutation(() =>
      runDatabaseTransaction(
        this.db,
        async (txDb) => {
          await lockRowForUpdate(txDb, this.db, branches, eq(branches.branch_id, input.branchId));
          const row = await select(txDb)
            .from(branches)
            .where(eq(branches.branch_id, input.branchId))
            .one();
          const data = row?.data as
            | { environment_instance?: BranchEnvironmentInstance; [key: string]: unknown }
            | undefined;
          const environment = data?.environment_instance;
          const state = environment?.source_sync;
          if (!row || row.archived || environment?.status !== 'running' || !state) {
            return { outcome: 'unavailable' };
          }
          if (state.desired_revision === state.applied_revision) return { outcome: 'up_to_date' };

          const now = await this.mutationNow(txDb, input.branchId);
          const retryAt = Date.parse(state.retry_not_before_at ?? '');
          if (Number.isFinite(retryAt) && retryAt > now.getTime()) {
            return { outcome: 'not_due', retry_at: new Date(retryAt).toISOString() };
          }
          const active = state.active_attempt;
          const activeLease = Date.parse(active?.lease_expires_at ?? '');
          if (
            active &&
            active.environment_generation === row.environment_generation &&
            Number.isFinite(activeLease) &&
            activeLease > now.getTime()
          ) {
            return { outcome: 'held', lease_expires_at: new Date(activeLease).toISOString() };
          }

          const attempt: SourceSyncAttempt = {
            token: input.claimToken,
            revision: state.desired_revision,
            environment_generation: row.environment_generation,
            started_at: now.toISOString(),
            lease_expires_at: new Date(now.getTime() + input.leaseDurationMs).toISOString(),
            instance_id: input.identity.instanceId,
            boot_id: input.identity.bootId,
            ...(state.requested_by_user_id
              ? { requested_by_user_id: state.requested_by_user_id }
              : {}),
          };
          const nextState: SourceSyncState = {
            ...state,
            active_attempt: attempt,
          };
          delete nextState.last_error;
          delete nextState.retry_not_before_at;
          await update(txDb, branches)
            .set({
              data: {
                ...data,
                environment_instance: { ...environment, source_sync: nextState },
              },
            })
            .where(eq(branches.branch_id, input.branchId))
            .run();
          return { outcome: 'claimed', attempt };
        },
        { sqliteImmediate: true }
      )
    );
  }

  async complete(input: {
    branchId: BranchID;
    claimToken: string;
    appliedRevision: string;
    environmentGeneration: number;
  }): Promise<EnvironmentSyncSettlementResult> {
    const appliedRevision = validateEnvironmentSourceRevision(input.appliedRevision);
    return this.runMutation(() =>
      runDatabaseTransaction(
        this.db,
        async (txDb) => {
          await lockRowForUpdate(txDb, this.db, branches, eq(branches.branch_id, input.branchId));
          const row = await select(txDb)
            .from(branches)
            .where(eq(branches.branch_id, input.branchId))
            .one();
          const data = row?.data as
            | { environment_instance?: BranchEnvironmentInstance; [key: string]: unknown }
            | undefined;
          const environment = data?.environment_instance;
          const state = environment?.source_sync;
          const attempt = state?.active_attempt;
          const now = row ? await this.mutationNow(txDb, input.branchId) : new Date();
          if (
            !row ||
            row.archived ||
            !state ||
            !attempt ||
            environment?.status !== 'running' ||
            row.environment_generation !== input.environmentGeneration ||
            attempt.environment_generation !== input.environmentGeneration ||
            attempt.token !== input.claimToken ||
            attempt.revision !== appliedRevision ||
            Date.parse(attempt.lease_expires_at) <= now.getTime()
          ) {
            return { outcome: 'stale' };
          }

          const nextState: SourceSyncState = {
            desired_revision: state.desired_revision,
            desired_at: state.desired_at,
            applied_revision: appliedRevision,
            applied_at: now.toISOString(),
            ...(state.requested_by_user_id
              ? { requested_by_user_id: state.requested_by_user_id }
              : {}),
          };
          await update(txDb, branches)
            .set({
              data: {
                ...data,
                environment_instance: {
                  ...environment,
                  source_sync: nextState,
                  last_command: {
                    action: 'sync',
                    status: 'succeeded',
                    timestamp: now.toISOString(),
                    message: `Applied source revision ${appliedRevision.slice(0, 12)}`,
                  },
                },
              },
              updated_at: now,
            })
            .where(eq(branches.branch_id, input.branchId))
            .run();
          return {
            outcome: 'settled',
            desired_revision: state.desired_revision,
            applied_revision: appliedRevision,
            needs_reconcile: state.desired_revision !== appliedRevision,
          };
        },
        { sqliteImmediate: true }
      )
    );
  }

  async fail(input: {
    branchId: BranchID;
    claimToken: string;
    revision: string;
    environmentGeneration: number;
    message: string;
  }): Promise<EnvironmentSyncSettlementResult> {
    const revision = validateEnvironmentSourceRevision(input.revision);
    return this.runMutation(() =>
      runDatabaseTransaction(
        this.db,
        async (txDb) => {
          await lockRowForUpdate(txDb, this.db, branches, eq(branches.branch_id, input.branchId));
          const row = await select(txDb)
            .from(branches)
            .where(eq(branches.branch_id, input.branchId))
            .one();
          const data = row?.data as
            | { environment_instance?: BranchEnvironmentInstance; [key: string]: unknown }
            | undefined;
          const environment = data?.environment_instance;
          const state = environment?.source_sync;
          const attempt = state?.active_attempt;
          if (
            !row ||
            !state ||
            !attempt ||
            row.environment_generation !== input.environmentGeneration ||
            attempt.environment_generation !== input.environmentGeneration ||
            attempt.token !== input.claimToken ||
            attempt.revision !== revision
          ) {
            return { outcome: 'stale' };
          }
          const now = await this.mutationNow(txDb, input.branchId);
          if (state.desired_revision !== revision) {
            const nextState: SourceSyncState = { ...state };
            delete nextState.active_attempt;
            await update(txDb, branches)
              .set({
                data: {
                  ...data,
                  environment_instance: { ...environment, source_sync: nextState },
                },
              })
              .where(eq(branches.branch_id, input.branchId))
              .run();
            return {
              outcome: 'settled',
              desired_revision: state.desired_revision,
              applied_revision: state.applied_revision,
              needs_reconcile: true,
            };
          }
          const failureCount = (state.failure_count ?? 0) + 1;
          const nextState: SourceSyncState = {
            desired_revision: state.desired_revision,
            desired_at: state.desired_at,
            ...(state.applied_revision
              ? { applied_revision: state.applied_revision, applied_at: state.applied_at }
              : {}),
            ...(state.requested_by_user_id
              ? { requested_by_user_id: state.requested_by_user_id }
              : {}),
            failure_count: failureCount,
            retry_not_before_at: new Date(now.getTime() + retryDelayMs(failureCount)).toISOString(),
            last_error: {
              revision,
              timestamp: now.toISOString(),
              message: sanitizeSyncError(input.message),
            },
          };
          await update(txDb, branches)
            .set({
              data: {
                ...data,
                environment_instance: {
                  ...environment,
                  source_sync: nextState,
                  last_command: {
                    action: 'sync',
                    status: 'failed',
                    timestamp: now.toISOString(),
                    message: sanitizeSyncError(input.message),
                  },
                },
              },
              updated_at: now,
            })
            .where(eq(branches.branch_id, input.branchId))
            .run();
          return {
            outcome: 'settled',
            desired_revision: state.desired_revision,
            applied_revision: state.applied_revision,
            needs_reconcile: state.desired_revision !== state.applied_revision,
          };
        },
        { sqliteImmediate: true }
      )
    );
  }
}
