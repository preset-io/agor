import type { BranchID, UserID, UUID } from './id';

export const BRANCH_DELETION_COMMAND = 'branch.delete';
export const BRANCH_DELETION_REPORT_SERVICE = 'branch-deletion-steps';
export const branchDeletionCommandId = (executionId: string) =>
  `${BRANCH_DELETION_COMMAND}:${executionId}`;
export interface BranchDeletionReferenceCursor {
  table: number;
  after?: string;
}

/** Internal shared maintenance ownership, persisted only on the branch row. */
export interface BranchMaintenanceClaim {
  branch_id: BranchID;
  operation_id: UUID;
  generation: number;
  kind: 'delete' | 'cleanup' | 'workspace_write';
  /** Cleared only after the executor owner proves settlement, never on lease expiry. */
  execution_id?: UUID;
  /** Dispatch intent and executor claim are separate: duplicate delivery must not execute twice. */
  execution_requested_at?: string;
  execution_claimed_at?: string;
  execution_heartbeat_at?: string;
  requested_by?: UserID;
  storage_verified?: boolean;
  reference_cursor?: BranchDeletionReferenceCursor;
  references_done?: boolean;
  data_done?: boolean;
}

/** Sticky branch lifecycle; failure never reopens normal work. */
export const BRANCH_DELETION_STATUSES = ['deleting', 'deletion_failed'] as const;
export type BranchDeletionStatus = (typeof BRANCH_DELETION_STATUSES)[number];

/** Bounded diagnostics, never resource contents or raw provider exceptions. */
export type BranchDeletionStage = 'claim' | 'storage' | 'data' | 'finalize';

export type BranchDeletionExecutionResult =
  | { outcome: 'deleted' }
  | { outcome: 'failed' | 'unknown'; stage: BranchDeletionStage; message: string };

/** Review contract; FK actions alone never establish exclusive ownership. */
export interface BranchDeletionRelationPolicy {
  disposition: 'delete_owned' | 'clear_reference' | 'retain' | 'classify';
  reason: string;
}
