import type { BranchID, UserID, UUID } from './id';
import type { TenantID } from './tenant';

/** Deletion is forward-only. A failed operation retains its last durable stage. */
export const BRANCH_DELETION_STAGES = [
  'requested',
  'quiescing',
  'inventorying',
  'deleting_storage',
  'deleting_data',
  'verifying',
] as const;
export type BranchDeletionStage = (typeof BRANCH_DELETION_STAGES)[number];
export type BranchDeletionStatus = 'pending' | 'running' | 'blocked' | 'failed' | 'completed';
export type BranchDeletionOperationID = UUID & { readonly __entity: 'BranchDeletionOperation' };

/** No paths, credentials, transcripts, or executor output in the public receipt. */
export interface BranchDeletionReceipt {
  operation_id: BranchDeletionOperationID;
  branch_id: BranchID;
  requested_by: UserID;
  confirmed_at: string;
  status: BranchDeletionStatus;
  stage: BranchDeletionStage;
  updated_at: string;
  completed_at: string | null;
  error_code: BranchDeletionErrorCode | null;
}

/** Domain-owned diagnostics, not arbitrary error strings supplied by a worker. */
export const BRANCH_DELETION_ERRORS = {
  containment_unverified: 'Writer containment has not been verified.',
  ownership_unverified: 'Resource ownership has not been verified.',
  storage_unavailable: 'Required storage is unavailable.',
  storage_removal_failed: 'Required storage removal failed.',
  invocation_unsettled: 'A previous storage invocation has not settled.',
  authority_revoked: 'Deletion authority must be re-established by an authorized Manager.',
  remaining_resources: 'Required resources remain.',
  inventory_changed: 'The resource inventory requires reconciliation.',
} as const;
export type BranchDeletionErrorCode = keyof typeof BRANCH_DELETION_ERRORS;

export type BranchDeletionResourceState = 'pending' | 'in_flight' | 'removed' | 'retained';
export type BranchDeletionResourceKind =
  | 'workspace'
  | 'sdk_home'
  | 'upload'
  | 'environment'
  | 'gateway'
  | 'knowledge_namespace'
  | 'database'
  | 'backup'
  | 'provider_conversation';

/** An approved exception is a policy, not a user-controlled "skip deletion" flag. */
export const BRANCH_DELETION_RETENTION = {
  shared_resource: 'Owned by a surviving board, repository, user, or namespace.',
  external_provider: 'External provider content is outside live Agor branch erasure.',
  backup_policy: 'Immutable backups remain subject to their configured expiry and locks.',
  security_receipt: 'Minimal revoked authority remains until its existing security expiry.',
} as const;
export type BranchDeletionRetentionReason = keyof typeof BRANCH_DELETION_RETENTION;

/** Private ledger identity, captured before its original lookup row is removed. */
export interface BranchDeletionResourceIdentity {
  resource_id: string;
  kind: BranchDeletionResourceKind;
  /** Storage-owner name. It is not a caller-selected executor or URL. */
  owner: string;
  /** Opaque storage-owner locator; never exposed in a receipt. */
  locator: string;
  /** Owner-provided generation/version; path absence alone is not evidence. */
  version: string;
}

/** Internal references bind every ledger read/write to trusted operation identity. */
export interface BranchDeletionOperationRef {
  tenant_id: TenantID;
  branch_id: BranchID;
  operation_id: BranchDeletionOperationID;
}

export interface BranchDeletionResource extends BranchDeletionResourceIdentity {
  state: BranchDeletionResourceState;
  invocation_id: UUID | null;
  retention_reason: BranchDeletionRetentionReason | null;
}

/** Review contract; FK actions alone never establish exclusive ownership. */
export interface BranchDeletionRelationPolicy {
  disposition: 'delete_owned' | 'clear_reference' | 'retain' | 'classify';
  reason: string;
}
