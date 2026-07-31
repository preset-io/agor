import type { Branch, BranchID, UserID } from '@agor/core/types';
import { analyticsLogger } from '../../analytics/logger';
import type { Database } from '../client';
import { AppVariableRepository } from './app-variables';
import { BranchRepository } from './branches';

/**
 * app_variables namespace for a user's primary teammate branch. The row key is
 * the user id, so there is one value per (tenant, user) — tenant scoping is
 * ambient via the tenant-scoped database, mirroring KnowledgeSemanticSettings.
 * Named distinctly from boards' `primary_teammate_id` to avoid any collision.
 */
export const USER_PRIMARY_TEAMMATE_NAMESPACE = 'user.primary_teammate_branch';

/** Analytics event emitted whenever a user's primary teammate branch is set. */
export const USER_PRIMARY_TEAMMATE_SET_EVENT = 'user.primary_teammate.set';

/**
 * How the primary teammate came to be set: `default` for backfill/onboarding
 * auto-assignment, `explicit` for a later user-driven pick (a future phase).
 */
export type PrimaryTeammateAssignmentSource = 'default' | 'explicit';

export interface SetPrimaryTeammateOptions {
  source: PrimaryTeammateAssignmentSource;
  /** Actor for the app_variable audit column; defaults to the target user. */
  updatedBy?: UserID | null;
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
  private variables: AppVariableRepository;
  private branches: BranchRepository;

  constructor(db: Database) {
    this.variables = new AppVariableRepository(db);
    this.branches = new BranchRepository(db);
  }

  /** Raw stored branch id for the user, or null when unset. */
  async getBranchId(userId: UserID): Promise<BranchID | null> {
    const value = await this.variables.getPlain(USER_PRIMARY_TEAMMATE_NAMESPACE, userId);
    return (value as BranchID | null) ?? null;
  }

  /**
   * Resolve the user's primary teammate branch, or null when unset OR the user
   * can no longer access the stored branch (deleted, unshared, ownership
   * removed). Null is the unambiguous "needs picking" signal for callers.
   *
   * The access check reuses the same branch-visibility predicate boards use to
   * resolve `primary_teammate_id`, so a teammate embedded on another board
   * still resolves as long as the user retains access to it.
   */
  async resolvePrimaryTeammate(userId: UserID): Promise<Branch | null> {
    const branchId = await this.getBranchId(userId);
    if (!branchId) return null;
    return this.branches.findAccessibleById(branchId, userId);
  }

  /** Set the user's primary teammate branch and emit the assignment event. */
  async setPrimaryTeammate(
    userId: UserID,
    branchId: BranchID,
    options: SetPrimaryTeammateOptions
  ): Promise<void> {
    await this.variables.set({
      namespace: USER_PRIMARY_TEAMMATE_NAMESPACE,
      key: userId,
      value: branchId,
      updated_by: options.updatedBy ?? userId,
    });
    analyticsLogger.track(
      USER_PRIMARY_TEAMMATE_SET_EVENT,
      buildPrimaryTeammateSetAnalyticsProperties(userId, branchId, options.source),
      { userId }
    );
  }

  /** Clear the user's primary teammate branch. */
  async clearPrimaryTeammate(userId: UserID): Promise<void> {
    await this.variables.delete(USER_PRIMARY_TEAMMATE_NAMESPACE, userId);
  }
}
