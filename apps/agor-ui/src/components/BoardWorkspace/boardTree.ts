import type { Branch, Session } from '@agor-live/client';
import { getTeammateConfig, isTeammate } from '@agor-live/client';
import type { BranchSort } from './useBoardViewPreferences';

export const branchTreeLabel = (branch: Branch) =>
  getTeammateConfig(branch)?.displayName ?? branch.name;
export function sortBoardTreeBranches(
  branches: Branch[],
  primaryId: string | undefined,
  sort: BranchSort,
  sessionsByBranch: Map<string, Session[]>
) {
  const rank = (branch: Branch) =>
    branch.branch_id === primaryId ? 0 : isTeammate(branch) ? 1 : 2;
  // Precompute once, not once per sort comparison. No spread of large session lists.
  const activity = new Map<string, number>();
  if (sort === 'recent') {
    for (const branch of branches) {
      let latest = Date.parse(branch.last_used) || 0;
      for (const session of sessionsByBranch.get(branch.branch_id) ?? []) {
        if (!session.archived) latest = Math.max(latest, Date.parse(session.last_updated) || 0);
      }
      activity.set(branch.branch_id, latest);
    }
  }
  return branches
    .filter((b) => !b.archived)
    .sort(
      (a, b) =>
        rank(a) - rank(b) ||
        (sort === 'recent' && rank(a) === 2
          ? (activity.get(b.branch_id) ?? 0) - (activity.get(a.branch_id) ?? 0)
          : 0) ||
        branchTreeLabel(a).localeCompare(branchTreeLabel(b), undefined, { sensitivity: 'base' }) ||
        a.branch_id.localeCompare(b.branch_id)
    );
}
