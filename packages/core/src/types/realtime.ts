import type { BranchID, UserID } from './id';
import type { TenantID } from './tenant';

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

/** Wire version for the internal cross-replica Feathers publication relay. */
export const REALTIME_RELAY_VERSION = 1 as const;

/** Bounded JSON envelope sent over the existing HA realtime relay. */
export interface RealtimeRelayEnvelope {
  version: typeof REALTIME_RELAY_VERSION;
  tenantId: TenantID;
  path: string;
  event: string;
  method?: string;
  id?: string | number;
  data: unknown;
  branchRemovalVisibility?: BranchRemovalRealtimeVisibilitySnapshot;
}

/** Redis-backed realtime dependency state exposed through daemon health. */
export interface RedisRealtimeHealth {
  required: true;
  ready: boolean;
  draining: boolean;
  adapterAttached: boolean;
  pubStatus: string;
  subStatus: string;
}
