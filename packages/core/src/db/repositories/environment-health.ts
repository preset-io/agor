import { and, asc, eq, gt, or, sql } from 'drizzle-orm';
import type { DistributedWorkIdentity } from '../../coordination';
import {
  decideEnvironmentHealthTransition,
  ENVIRONMENT_STARTUP_TIMEOUT_MS,
} from '../../environment/health-transition';
import type { BranchEnvironmentInstance, BranchID, TenantID } from '../../types';
import type { Database, SystemDatabase } from '../client';
import {
  isPostgresDatabase,
  jsonExtract,
  lockRowForUpdate,
  runDatabaseTransaction,
  select,
  update,
} from '../database-wrapper';
import { branches } from '../schema';
import { EntityNotFoundError, RepositoryError } from './base';

export interface EnvironmentHealthRoutingRef {
  branch_id: BranchID;
  tenant_id: TenantID;
}

export interface EnvironmentHealthRoutingCursor {
  tenant_id: TenantID;
  branch_id: BranchID;
}

export interface EnvironmentHealthClaim {
  branch_id: BranchID;
  claim_token: string;
  claim_generation: number;
  environment_generation: number;
  claimed_at: string;
  lease_expires_at: string;
  instance_id: string;
  boot_id: string;
}

export type EnvironmentHealthClaimResult =
  | { outcome: 'claimed'; claim: EnvironmentHealthClaim }
  | { outcome: 'held'; lease_expires_at: string | null }
  | { outcome: 'not_due'; next_observation_at: string }
  | { outcome: 'unavailable' };

export interface EnvironmentHealthObservation {
  status: 'healthy' | 'unhealthy' | 'unknown';
  message: string;
  /** Network failures during startup preserve the historical grace behavior. */
  recordWhileStarting: boolean;
}

export type EnvironmentHealthCommitResult =
  | { outcome: 'stale' }
  | {
      outcome: 'committed';
      mutated: boolean;
      stateChanged: boolean;
      /**
       * Status AFTER the observation. Includes `error`: an environment is only
       * admitted for observation while `starting`/`running`, but the transition
       * rules can demote it here (unreachable, or a startup that never became
       * reachable).
       */
      environmentStatus: 'starting' | 'running' | 'error';
    };

function startupDeadlineAtMs(environment: BranchEnvironmentInstance): number | undefined {
  const persisted = Date.parse(environment.startup_deadline_at ?? '');
  if (Number.isFinite(persisted)) return persisted;

  // Compatibility for attempts started before startup_deadline_at existed.
  // This still uses persisted wall-clock state, never the number/cadence of
  // probes, so a daemon outage cannot grant an old attempt more time.
  const startedAt = Date.parse(environment.process?.started_at ?? '');
  return Number.isFinite(startedAt) ? startedAt + ENVIRONMENT_STARTUP_TIMEOUT_MS : undefined;
}

/**
 * System-scope discovery exposes routing metadata only. The RLS capability
 * policy independently limits rows to non-archived active environments.
 */
export class EnvironmentHealthDiscoveryRepository {
  constructor(private readonly db: SystemDatabase) {}

  async findActiveRefs(options: {
    limit: number;
    after?: EnvironmentHealthRoutingCursor;
  }): Promise<EnvironmentHealthRoutingRef[]> {
    if (!isPostgresDatabase(this.db)) {
      throw new RepositoryError('Distributed environment health discovery requires PostgreSQL');
    }
    if (!Number.isInteger(options.limit) || options.limit <= 0 || options.limit > 1_000) {
      throw new RepositoryError('Environment health discovery limit must be between 1 and 1000');
    }
    const tenantColumn = (branches as unknown as { tenant_id?: typeof branches.branch_id })
      .tenant_id;
    if (!tenantColumn) {
      throw new RepositoryError('Environment health discovery requires tenant metadata');
    }
    const status = sql`${jsonExtract(this.db, branches.data, 'environment_instance.status')}`;
    const after = options.after
      ? or(
          gt(tenantColumn, options.after.tenant_id),
          and(
            eq(tenantColumn, options.after.tenant_id),
            gt(branches.branch_id, options.after.branch_id)
          )
        )
      : undefined;
    const rows = await select(this.db, {
      branch_id: branches.branch_id,
      tenant_id: tenantColumn,
    })
      .from(branches)
      .where(
        and(eq(branches.archived, false), or(eq(status, 'starting'), eq(status, 'running')), after)
      )
      .orderBy(asc(tenantColumn), asc(branches.branch_id))
      .limit(options.limit)
      .all();

    return rows.map((row: { branch_id: string; tenant_id: string | null }) => {
      if (!row.tenant_id) {
        throw new RepositoryError(
          `Environment health discovery returned branch ${row.branch_id} without tenant metadata`
        );
      }
      return {
        branch_id: row.branch_id as BranchID,
        tenant_id: row.tenant_id as TenantID,
      };
    });
  }
}

/** Thin, tenant-scoped coordination and fenced-result API. */
export class EnvironmentHealthRepository {
  constructor(private readonly db: Database) {}

  private validateClaimInput(input: {
    claimToken: string;
    leaseDurationMs: number;
    identity: DistributedWorkIdentity;
  }): void {
    if (!input.claimToken.trim())
      throw new RepositoryError('Environment health claim token required');
    if (!input.identity.instanceId.trim() || !input.identity.bootId.trim()) {
      throw new RepositoryError('Environment health diagnostic identity required');
    }
    if (!Number.isSafeInteger(input.leaseDurationMs) || input.leaseDurationMs <= 0) {
      throw new RepositoryError('Environment health claim lease must be a positive integer');
    }
  }

  private async mutationNow(txDb: Database, branchId: BranchID): Promise<Date> {
    if (!isPostgresDatabase(this.db)) return new Date();
    // CURRENT_TIMESTAMP is fixed at transaction start in PostgreSQL. These
    // transactions may wait on the branch row lock, so use wall-clock database
    // time after lock acquisition for lease/cooldown fencing.
    const row = await select(txDb, { value: sql<Date>`clock_timestamp()` })
      .from(branches)
      .where(eq(branches.branch_id, branchId))
      .one();
    if (!row) throw new EntityNotFoundError('Branch', branchId);
    return row.value instanceof Date ? row.value : new Date(row.value);
  }

  async claim(input: {
    branchId: BranchID;
    claimToken: string;
    leaseDurationMs: number;
    identity: DistributedWorkIdentity;
    /** Explicit user probes may bypass cadence cooldown, never a live owner. */
    ignoreCooldown?: boolean;
  }): Promise<EnvironmentHealthClaimResult> {
    this.validateClaimInput(input);
    return runDatabaseTransaction(
      this.db,
      async (txDb) => {
        await lockRowForUpdate(txDb, this.db, branches, eq(branches.branch_id, input.branchId));
        const row = await select(txDb)
          .from(branches)
          .where(eq(branches.branch_id, input.branchId))
          .one();
        const status = (
          row?.data as { environment_instance?: BranchEnvironmentInstance } | undefined
        )?.environment_instance?.status;
        if (!row || row.archived || (status !== 'starting' && status !== 'running')) {
          return { outcome: 'unavailable' };
        }
        const now = await this.mutationNow(txDb, input.branchId);
        if (
          row.environment_health_claim_token &&
          row.environment_health_claim_expires_at &&
          new Date(row.environment_health_claim_expires_at).getTime() > now.getTime()
        ) {
          return {
            outcome: 'held',
            lease_expires_at: new Date(row.environment_health_claim_expires_at).toISOString(),
          };
        }
        // A cleared token means the previous observation completed and set a
        // fleet-wide cooldown. An expired token means its owner died, so
        // takeover is admitted after lease expiry regardless of the cooldown.
        if (
          !input.ignoreCooldown &&
          !row.environment_health_claim_token &&
          row.environment_health_next_observation_at &&
          new Date(row.environment_health_next_observation_at).getTime() > now.getTime()
        ) {
          return {
            outcome: 'not_due',
            next_observation_at: new Date(row.environment_health_next_observation_at).toISOString(),
          };
        }

        const claimGeneration = row.environment_health_claim_generation + 1;
        const expiresAt = new Date(now.getTime() + input.leaseDurationMs);
        await update(txDb, branches)
          .set({
            environment_health_claim_token: input.claimToken,
            environment_health_claimed_at: now,
            environment_health_claim_expires_at: expiresAt,
            environment_health_claim_instance_id: input.identity.instanceId,
            environment_health_claim_boot_id: input.identity.bootId,
            environment_health_claim_generation: claimGeneration,
          })
          .where(eq(branches.branch_id, input.branchId))
          .run();
        return {
          outcome: 'claimed',
          claim: {
            branch_id: input.branchId,
            claim_token: input.claimToken,
            claim_generation: claimGeneration,
            environment_generation: row.environment_generation,
            claimed_at: now.toISOString(),
            lease_expires_at: expiresAt.toISOString(),
            instance_id: input.identity.instanceId,
            boot_id: input.identity.bootId,
          },
        };
      },
      { sqliteImmediate: true }
    );
  }

  /** Renew only a live token bound to the same active lifecycle generation. */
  async renew(input: {
    branchId: BranchID;
    claimToken: string;
    environmentGeneration: number;
    leaseDurationMs: number;
  }): Promise<EnvironmentHealthClaim | null> {
    if (
      !input.claimToken.trim() ||
      !Number.isSafeInteger(input.leaseDurationMs) ||
      input.leaseDurationMs <= 0
    ) {
      throw new RepositoryError('Valid environment health renewal token and duration required');
    }
    return runDatabaseTransaction(
      this.db,
      async (txDb) => {
        await lockRowForUpdate(txDb, this.db, branches, eq(branches.branch_id, input.branchId));
        const row = await select(txDb)
          .from(branches)
          .where(eq(branches.branch_id, input.branchId))
          .one();
        const status = (
          row?.data as { environment_instance?: BranchEnvironmentInstance } | undefined
        )?.environment_instance?.status;
        if (
          !row ||
          row.archived ||
          (status !== 'starting' && status !== 'running') ||
          row.environment_generation !== input.environmentGeneration ||
          row.environment_health_claim_token !== input.claimToken
        ) {
          return null;
        }
        const now = await this.mutationNow(txDb, input.branchId);
        if (
          !row.environment_health_claim_expires_at ||
          new Date(row.environment_health_claim_expires_at).getTime() <= now.getTime()
        ) {
          return null;
        }
        const expiresAt = new Date(now.getTime() + input.leaseDurationMs);
        await update(txDb, branches)
          .set({ environment_health_claim_expires_at: expiresAt })
          .where(
            and(
              eq(branches.branch_id, input.branchId),
              eq(branches.environment_health_claim_token, input.claimToken)
            )
          )
          .run();
        return {
          branch_id: input.branchId,
          claim_token: input.claimToken,
          claim_generation: row.environment_health_claim_generation,
          environment_generation: row.environment_generation,
          claimed_at: new Date(row.environment_health_claimed_at ?? now).toISOString(),
          lease_expires_at: expiresAt.toISOString(),
          instance_id: row.environment_health_claim_instance_id ?? 'unknown',
          boot_id: row.environment_health_claim_boot_id ?? 'unknown',
        };
      },
      { sqliteImmediate: true }
    );
  }

  async claimIsCurrent(input: {
    branchId: BranchID;
    claimToken: string;
    environmentGeneration: number;
  }): Promise<boolean> {
    const expiry = isPostgresDatabase(this.db)
      ? sql`${branches.environment_health_claim_expires_at} > CURRENT_TIMESTAMP`
      : gt(branches.environment_health_claim_expires_at, new Date());
    const status = sql`${jsonExtract(this.db, branches.data, 'environment_instance.status')}`;
    const row = await select(this.db, { branch_id: branches.branch_id })
      .from(branches)
      .where(
        and(
          eq(branches.branch_id, input.branchId),
          eq(branches.archived, false),
          or(eq(status, 'starting'), eq(status, 'running')),
          eq(branches.environment_generation, input.environmentGeneration),
          eq(branches.environment_health_claim_token, input.claimToken),
          expiry
        )
      )
      .one();
    return !!row;
  }

  /**
   * Revalidates status, lifecycle generation, token, and DB-time expiry while
   * holding the row lock, then writes the observation. The worker releases the
   * one-observation claim into a durable cooldown; lifecycle updates revoke it.
   */
  async commit(input: {
    branchId: BranchID;
    claimToken: string;
    environmentGeneration: number;
    observation: EnvironmentHealthObservation;
  }): Promise<EnvironmentHealthCommitResult> {
    return runDatabaseTransaction(
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
        const status = environment?.status;
        const now = row ? await this.mutationNow(txDb, input.branchId) : new Date();
        if (
          !row ||
          row.archived ||
          (status !== 'starting' && status !== 'running') ||
          row.environment_generation !== input.environmentGeneration ||
          row.environment_health_claim_token !== input.claimToken ||
          !row.environment_health_claim_expires_at ||
          new Date(row.environment_health_claim_expires_at).getTime() <= now.getTime()
        ) {
          return { outcome: 'stale' };
        }
        const activeEnvironment = environment as BranchEnvironmentInstance;

        // Same rules the standalone monitor applies, so an environment reaches
        // the same status under either monitor. Previously this promoted
        // `starting -> running` on a SINGLE healthy observation and never
        // demoted or timed out at all, so a resuming tunnel's one stale 200
        // could report an environment live while it was still booting, and one
        // that went away stayed green forever.
        const decision = decideEnvironmentHealthTransition({
          currentStatus: status,
          observation: input.observation.status,
          previous: activeEnvironment.last_health_check,
          observedAtMs: now.getTime(),
          startupDeadlineAtMs: startupDeadlineAtMs(activeEnvironment),
        });
        // Network failures during legitimate startup remain unrecorded, but an
        // expired attempt MUST persist its terminal transition. Previously the
        // decision returned `error` while shouldRecord stayed false, so the row
        // remained `starting` forever despite the apparent timeout result.
        const shouldRecord =
          status === 'running' ||
          input.observation.status === 'healthy' ||
          input.observation.recordWhileStarting ||
          decision.nextStatus !== undefined;
        const nextStatus = decision.nextStatus ?? status;
        const previousHealth = activeEnvironment.last_health_check;
        const stateChanged =
          shouldRecord &&
          (nextStatus !== status ||
            previousHealth?.status !== input.observation.status ||
            previousHealth?.message !== input.observation.message);
        const nextEnvironment: BranchEnvironmentInstance = shouldRecord
          ? {
              ...activeEnvironment,
              status: nextStatus,
              last_health_check: {
                timestamp: now.toISOString(),
                status: input.observation.status,
                message: input.observation.message,
                consecutive: decision.consecutive,
              },
            }
          : activeEnvironment;
        // A network failure while an environment is still starting is a
        // legitimate, deliberately unrecorded observation: startup grace
        // keeps the prior durable state until a recordable result arrives.
        // The row lock and fences above still authorize it as a completed
        // observation, but there are no branch columns to mutate. Do not hand
        // an empty update to Drizzle, whose dialect-independent set mapper
        // rejects it with "No values to set".
        if (shouldRecord) {
          await update(txDb, branches)
            .set({
              data: { ...data, environment_instance: nextEnvironment },
              ...(stateChanged ? { updated_at: now } : {}),
            })
            .where(
              and(
                eq(branches.branch_id, input.branchId),
                eq(branches.environment_health_claim_token, input.claimToken)
              )
            )
            .run();
        }
        return {
          outcome: 'committed',
          mutated: shouldRecord,
          stateChanged,
          environmentStatus: nextStatus,
        };
      },
      { sqliteImmediate: true }
    );
  }

  async release(
    branchId: BranchID,
    claimToken: string,
    nextObservationDelayMs?: number
  ): Promise<boolean> {
    if (
      nextObservationDelayMs !== undefined &&
      (!Number.isSafeInteger(nextObservationDelayMs) || nextObservationDelayMs <= 0)
    ) {
      throw new RepositoryError('Environment health observation cooldown must be positive');
    }
    return runDatabaseTransaction(
      this.db,
      async (txDb) => {
        await lockRowForUpdate(txDb, this.db, branches, eq(branches.branch_id, branchId));
        const row = await select(txDb).from(branches).where(eq(branches.branch_id, branchId)).one();
        if (!row || row.environment_health_claim_token !== claimToken) return false;
        const now =
          nextObservationDelayMs === undefined ? undefined : await this.mutationNow(txDb, branchId);
        const result = await update(txDb, branches)
          .set({
            environment_health_claim_token: null,
            environment_health_claimed_at: null,
            environment_health_claim_expires_at: null,
            environment_health_claim_instance_id: null,
            environment_health_claim_boot_id: null,
            ...(now && nextObservationDelayMs
              ? {
                  environment_health_next_observation_at: new Date(
                    now.getTime() + nextObservationDelayMs
                  ),
                }
              : {}),
          })
          .where(
            and(
              eq(branches.branch_id, branchId),
              eq(branches.environment_health_claim_token, claimToken)
            )
          )
          .run();
        return result.rowsAffected > 0;
      },
      { sqliteImmediate: true }
    );
  }
}
