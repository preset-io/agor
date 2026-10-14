/**
 * Branch counts service
 *
 * `find()` returns the number of active (non-archived) branches per board for
 * the board-switcher and mobile nav-tree badges, so they stay correct without
 * loading every branch into the browser.
 *
 * RBAC: the `scopeFindToAccessibleBranchesSql` before-hook marks regular
 * callers, and the repository then counts only branches the caller can view on
 * boards the caller can view — the same predicates as `branches.find` and
 * `boards.find`. A count is a derived read of tenant-owned rows; tenancy comes
 * from the same row-level security as every branch read. Never published.
 */
import { BranchRepository, type TenantScopeAwareDatabase } from '@agor/core/db';
import type { BoardBranchCount, UUID } from '@agor/core/types';

export interface BranchCountsParams {
  query?: Record<string, unknown>;
  /** Internal RBAC SQL pushdown marker set by `scopeFindToAccessibleBranchesSql`. */
  _agorSqlBranchAccessUserId?: UUID;
}

export class BranchCountsService {
  private readonly branches: BranchRepository;

  constructor(db: TenantScopeAwareDatabase) {
    this.branches = new BranchRepository(db);
  }

  async find(params?: BranchCountsParams): Promise<BoardBranchCount[]> {
    return this.branches.countActiveByBoard({
      visibleToUserId: params?._agorSqlBranchAccessUserId,
    });
  }
}

export function createBranchCountsService(db: TenantScopeAwareDatabase): BranchCountsService {
  return new BranchCountsService(db);
}
