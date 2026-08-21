import type { Branch, BranchID, UserID } from '@agor/core/types';
import { isTeammate } from '@agor/core/types';
import { and, eq, isNull } from 'drizzle-orm';
import { analyticsLogger } from '../../analytics/logger';
import type { Database } from '../client';
import {
  jsonExtract,
  jsonRemoveProperty,
  jsonSetString,
  select,
  update,
} from '../database-wrapper';
import { users } from '../schema';
import { BranchRepository } from './branches';

/** Analytics event emitted whenever a user's primary teammate branch is set. */
export const USER_PRIMARY_TEAMMATE_SET_EVENT = 'user.primary_teammate.set';

/**
 * How the primary teammate came to be set: `default` for backfill/onboarding
 * auto-assignment, `explicit` for a user-driven Settings pick.
 */
export type PrimaryTeammateAssignmentSource = 'default' | 'explicit';

export interface SetPrimaryTeammateOptions {
  source: PrimaryTeammateAssignmentSource;
}

export interface ResolvePrimaryTeammateOptions {
  /** Apply the session-or-better access policy used by session creation. */
  enforceAccess?: boolean;
}

export function buildPrimaryTeammateSetAnalyticsProperties(
  userId: UserID,
  branchId: BranchID,
  source: PrimaryTeammateAssignmentSource
): Record<string, unknown> {
  return {
    user_id: userId,
    branch_id: branchId,
    source,
  };
}

/**
 * Per-user, per-tenant primary teammate branch. Construct with a tenant-scoped
 * database; reads and writes are scoped to the ambient tenant.
 */
export class UserPrimaryTeammateRepository {
  private branches: BranchRepository;

  constructor(db: Database) {
    this.branches = new BranchRepository(db);
    this.db = db;
  }

  private db: Database;

  /** Raw stored branch id for the user, or null when unset. */
  async getBranchId(userId: UserID): Promise<BranchID | null> {
    const row = await select(this.db, {
      branchId: jsonExtract(this.db, users.data, 'primary_teammate_id'),
    })
      .from(users)
      .where(eq(users.user_id, userId))
      .one();
    return (row?.branchId as BranchID | null | undefined) ?? null;
  }

  /**
   * Resolve the user's active primary teammate branch, or null when unset,
   * ineligible, or no longer usable under the configured access policy. Null is
   * the unambiguous "needs picking" signal for callers.
   */
  async resolvePrimaryTeammate(
    userId: UserID,
    options: ResolvePrimaryTeammateOptions = {}
  ): Promise<Branch | null> {
    const branchId = await this.getBranchId(userId);
    if (!branchId) return null;
    return this.findEligiblePrimaryTeammate(branchId, userId, options);
  }

  /** Resolve an active teammate the caller can actually start a session on. */
  async findEligiblePrimaryTeammate(
    branchId: BranchID,
    userId: UserID,
    options: ResolvePrimaryTeammateOptions = {}
  ): Promise<Branch | null> {
    const branch = await this.branches.findAccessibleById(branchId, userId, {
      minimumPermission: 'session',
      enforceAccess: options.enforceAccess,
    });
    if (!branch || branch.archived || !isTeammate(branch)) return null;
    return branch;
  }

  /**
   * List the active teammates a user can actually start a session on. Keeping
   * this beside the point lookup ensures settings choices and assignment use
   * one eligibility policy.
   */
  async findEligiblePrimaryTeammates(
    userId: UserID,
    options: ResolvePrimaryTeammateOptions = {}
  ): Promise<Branch[]> {
    const candidates: Branch[] = [];
    const pageSize = 200;
    for (let offset = 0; ; offset += pageSize) {
      const page = await this.branches.findTeammateBranches({
        archived: false,
        ...(options.enforceAccess === false
          ? {}
          : { userId, minimumPermission: 'session' as const }),
        // Settings is not itself a paging UI, so exhaust repository pages. The
        // eligibility predicate remains set-wise in SQL rather than N+1 reads.
        limit: pageSize,
        offset,
      });
      candidates.push(...page);
      if (page.length < pageSize) break;
    }
    return candidates.filter(isTeammate);
  }

  /** Set the user's primary teammate branch and emit the assignment event. */
  async setPrimaryTeammate(
    userId: UserID,
    branchId: BranchID,
    options: SetPrimaryTeammateOptions
  ): Promise<void> {
    await update(this.db, users)
      .set({
        updated_at: new Date(),
        data: jsonSetString(this.db, users.data, 'primary_teammate_id', branchId),
      })
      .where(eq(users.user_id, userId))
      .run();
    analyticsLogger.track(
      USER_PRIMARY_TEAMMATE_SET_EVENT,
      buildPrimaryTeammateSetAnalyticsProperties(userId, branchId, options.source),
      { userId }
    );
  }

  /** Set a default only when no explicit/concurrent selection already exists. */
  async setPrimaryTeammateIfUnset(
    userId: UserID,
    branchId: BranchID,
    options: SetPrimaryTeammateOptions
  ): Promise<boolean> {
    const updated = await update(this.db, users)
      .set({
        updated_at: new Date(),
        data: jsonSetString(this.db, users.data, 'primary_teammate_id', branchId),
      })
      .where(
        and(
          eq(users.user_id, userId),
          isNull(jsonExtract(this.db, users.data, 'primary_teammate_id'))
        )
      )
      .returning({ userId: users.user_id })
      .one();
    const inserted = Boolean(updated);
    if (inserted) {
      analyticsLogger.track(
        USER_PRIMARY_TEAMMATE_SET_EVENT,
        buildPrimaryTeammateSetAnalyticsProperties(userId, branchId, options.source),
        { userId }
      );
    }
    return inserted;
  }

  /** Clear the user's primary teammate branch. */
  async clearPrimaryTeammate(userId: UserID): Promise<void> {
    await update(this.db, users)
      .set({
        updated_at: new Date(),
        data: jsonRemoveProperty(this.db, users.data, 'primary_teammate_id'),
      })
      .where(eq(users.user_id, userId))
      .run();
  }
}
