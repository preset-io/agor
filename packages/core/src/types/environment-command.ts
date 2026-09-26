import type { EnvironmentLifecycleResult } from '../environment/lifecycle-result';
import type { BranchEnvironmentInstance } from './branch';
import type { BranchID, UserID } from './id';

/** One bounded command, not a remote-resource ownership or readiness guarantee. */
export const ENVIRONMENT_COMMAND_ACTIONS = ['start', 'stop', 'nuke'] as const;
export type EnvironmentCommandAction = (typeof ENVIRONMENT_COMMAND_ACTIONS)[number];
export const ENVIRONMENT_COMMAND_REPORT_SERVICE = 'environment-command-reports';
export const ENVIRONMENT_COMMAND_BUDGET = {
  launchMs: 10_000,
  claimMs: 60_000,
  /** External/HA jobs keep their existing short execution envelope. */
  commandMs: 300_000,
  /** Standalone commands historically had no cap; bound them without breaking slow cold starts. */
  standaloneCommandMs: 25 * 60_000,
  cleanupMs: 5_000,
  reportMs: 30_000,
  outputBytes: 32_768,
  history: 3,
} as const;

export interface EnvironmentCommandAttempt {
  id: string;
  action: EnvironmentCommandAction;
  requested_by: UserID;
  requested_at: string;
  /** Persisted so every replica and executor uses the admitted command budget. */
  command_budget_ms?: number;
  claim_deadline: string;
  command_deadline: string;
  result_deadline: string;
  claimed_at?: string;
  finished_at?: string;
  /** Exact failed/uncertain attempt the operator explicitly accepted. */
  confirmation_of?: string;
  output?: string;
  output_truncated?: boolean;
  output_sequence?: number;
}

export type EnvironmentCommandReport = {
  branch_id: BranchID;
  attempt_id: string;
  action: EnvironmentCommandAction;
} & (
  | { kind: 'claim' }
  | { kind: 'output'; sequence: number; output: string; truncated: boolean }
  | {
      kind: 'result';
      outcome: 'succeeded' | 'failed' | 'unknown';
      output?: string;
      truncated?: boolean;
      message: string;
      lifecycle_result?: EnvironmentLifecycleResult;
    }
);

export function environmentCommandTokenId(action: EnvironmentCommandAction, attemptId: string) {
  return `environment.${action}:${encodeURIComponent(attemptId)}`;
}

export function hasActiveEnvironmentCommand(environment?: BranchEnvironmentInstance): boolean {
  return !!environment?.command_attempt && !environment.command_attempt.finished_at;
}

export function environmentStartConfirmation(environment?: BranchEnvironmentInstance) {
  return environment?.command_attempt?.finished_at &&
    environment.last_command?.status !== 'succeeded'
    ? environment.command_attempt.id
    : undefined;
}
