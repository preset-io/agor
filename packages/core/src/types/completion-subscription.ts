import type { BranchID, CompletionSubscriptionID, SessionID, TaskID, UserID } from './id';

/** Opt-in completion routing. Existing callbacks remain direct by default. */
export type CompletionPropagationMode = 'direct' | 'root';

/**
 * Root propagation deliberately supports one designated continuation. Parallel
 * helper children are allowed, but exactly one child may continue the requested
 * unit of work at each hop.
 */
export type CompletionJoinPolicy = 'designated_child';

export type CompletionSubscriptionState =
  | 'pending'
  | 'delegated'
  | 'running_downstream'
  | 'terminal_pending'
  | 'delivered'
  | 'delivery_failed';

export type CompletionTerminalStatus = 'completed' | 'failed' | 'cancelled' | 'timed_out';

export interface CompletionDelegationHop {
  session_id: SessionID;
  task_id: TaskID;
  branch_id?: BranchID;
  delegated_at?: string;
}

/** Bounded terminal facts retained even if the downstream Session is deleted. */
export interface CompletionTerminalSnapshot {
  session_id: SessionID;
  task_id: TaskID;
  branch_id?: BranchID;
  status: CompletionTerminalStatus;
  completed_at: string;
  reason?: string;
}

export interface CompletionSubscription {
  subscription_id: CompletionSubscriptionID;
  propagation_mode: 'root';
  join_policy: CompletionJoinPolicy;
  state: CompletionSubscriptionState;
  requested_by_user_id: UserID;
  /** Immutable audit identities; deliberately retained after entity deletion. */
  origin_session_id: SessionID;
  origin_task_id: TaskID;
  callback_session_id: SessionID | null;
  root_session_id: SessionID | null;
  root_task_id: TaskID | null;
  active_session_id: SessionID | null;
  active_task_id: TaskID | null;
  path: CompletionDelegationHop[];
  max_depth: number;
  terminal_status: CompletionTerminalStatus | null;
  terminal_snapshot: CompletionTerminalSnapshot | null;
  delivery_task_id: TaskID | null;
  delivery_attempt_count: number;
  next_delivery_at: string | null;
  last_delivery_error_code: string | null;
  created_at: string;
  updated_at: string;
  delegated_at: string | null;
  terminal_at: string | null;
  delivered_at: string | null;
}
