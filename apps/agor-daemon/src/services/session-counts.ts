/**
 * Session counts service
 *
 * `find({ query: { group_by } })` returns the number of active (non-archived)
 * sessions per branch or per board, for the settings tables, in one read
 * instead of one count per row.
 *
 * RBAC: the `scopeFindToAccessibleBranchesSql` before-hook marks regular
 * callers, and the repository then counts only sessions on branches the
 * caller can view — the same visibility as `sessions.find`. A count is a
 * derived read of tenant-owned rows; tenancy comes from the tenant condition
 * and row-level security. Never published.
 */
import { SessionRepository, type TenantScopeAwareDatabase } from '@agor/core/db';
import type { SessionCount, UUID } from '@agor/core/types';

export function createSessionCountsService(db: TenantScopeAwareDatabase) {
  const sessions = new SessionRepository(db);
  return {
    async find(params?: {
      query?: { group_by?: 'branch_id' | 'board_id' };
      /** Internal RBAC SQL pushdown marker set by `scopeFindToAccessibleBranchesSql`. */
      _agorSqlBranchAccessUserId?: UUID;
    }): Promise<SessionCount[]> {
      return sessions.countActive({
        groupBy: params?.query?.group_by === 'board_id' ? 'board_id' : 'branch_id',
        visibleToUserId: params?._agorSqlBranchAccessUserId,
      });
    },
  };
}
