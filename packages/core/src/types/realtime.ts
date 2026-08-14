import type { BranchID, UserID } from './id';

/** Canonical discriminants for branch visibility at realtime boundaries. */
export const BranchRealtimeVisibilityMode = {
  ALL_AUTHENTICATED: 'allAuthenticated',
  EXPLICIT_USERS: 'explicitUsers',
} as const;

export type BranchRealtimeVisibilityMode =
  (typeof BranchRealtimeVisibilityMode)[keyof typeof BranchRealtimeVisibilityMode];

/** In-process branch visibility resolved from current tenant/RBAC state. */
export type BranchRealtimeVisibility =
  | { mode: typeof BranchRealtimeVisibilityMode.ALL_AUTHENTICATED }
  | {
      mode: typeof BranchRealtimeVisibilityMode.EXPLICIT_USERS;
      userIds: ReadonlySet<UserID>;
    };

/**
 * Serializable authorization snapshot for a committed branch tombstone.
 * Branch and ACL rows no longer exist when the removal is published.
 */
export type BranchRemovalRealtimeVisibilitySnapshot =
  | {
      branchId: BranchID;
      mode: typeof BranchRealtimeVisibilityMode.ALL_AUTHENTICATED;
    }
  | {
      branchId: BranchID;
      mode: typeof BranchRealtimeVisibilityMode.EXPLICIT_USERS;
      userIds: UserID[];
    };

/** Redis-backed realtime dependency state exposed through daemon health. */
export interface RedisRealtimeHealth {
  required: true;
  ready: boolean;
  draining: boolean;
  adapterAttached: boolean;
  pubStatus: string;
  subStatus: string;
}
