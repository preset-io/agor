import type { BranchTabConfig } from './tabs/BranchTab';

/** Arguments (minus repoId) passed to the branch-create handler. */
export interface BranchCreateArgs {
  name: string;
  ref: string;
  refType?: 'branch' | 'tag';
  createBranch: boolean;
  sourceBranch: string;
  pullLatest: boolean;
  issue_url?: string;
  pull_request_url?: string;
  boardId?: string;
  position?: { x: number; y: number };
  storage_mode?: 'worktree' | 'clone';
  clone_depth?: number;
}

/**
 * Map the CreateDialog's Branch tab result onto the branch-create handler
 * arguments. Board placement (boardId + position) is threaded through so the
 * branch lands atomically. Shared by both shells so the mapping lives once.
 */
export function branchTabConfigToCreateArgs(config: BranchTabConfig): BranchCreateArgs {
  return {
    name: config.name,
    ref: config.ref,
    refType: config.refType,
    createBranch: config.createBranch,
    sourceBranch: config.sourceBranch,
    pullLatest: config.pullLatest,
    issue_url: config.issue_url,
    pull_request_url: config.pull_request_url,
    ...(config.board_id ? { boardId: config.board_id } : {}),
    ...(config.position ? { position: config.position } : {}),
    ...(config.storage_mode ? { storage_mode: config.storage_mode } : {}),
    ...(config.clone_depth !== undefined ? { clone_depth: config.clone_depth } : {}),
  };
}
