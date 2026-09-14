/** Repository-approved executable configuration; never loaded from a branch checkout. */
export interface RepoCleanupPolicy {
  enabled: boolean;
  command: string;
  allow_branch_protection: boolean;
}

export const DEFAULT_BRANCH_CLEANUP_COMMAND = 'git clean -fdX';
export const BRANCH_CLEANUP_COMMAND_MAX_LENGTH = 4096;
export const BRANCH_CLEANUP_COMMAND = 'branch.clean';
export const BRANCH_ARCHIVE_COMMAND = 'branch.archive';
export const BRANCH_CLEANUP_TIMEOUT_MS = 5 * 60_000;
export const DEFAULT_REPO_CLEANUP_POLICY: Readonly<RepoCleanupPolicy> = Object.freeze({
  enabled: false,
  command: DEFAULT_BRANCH_CLEANUP_COMMAND,
  allow_branch_protection: true,
});

/** Missing legacy configuration never opts a repository into execution. */
export function resolveRepoCleanupPolicy(policy?: RepoCleanupPolicy | null): RepoCleanupPolicy {
  return policy ?? { ...DEFAULT_REPO_CLEANUP_POLICY };
}

/** Complete replacement, not a nested patch; reject unknown execution overrides. */
export function validateRepoCleanupPolicy(value: unknown): RepoCleanupPolicy {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Cleanup policy must be an object');
  }
  const policy = value as Record<string, unknown>;
  if (
    Object.keys(policy).some((key) => !Object.hasOwn(DEFAULT_REPO_CLEANUP_POLICY, key)) ||
    typeof policy.enabled !== 'boolean' ||
    typeof policy.allow_branch_protection !== 'boolean' ||
    typeof policy.command !== 'string' ||
    policy.command.length > BRANCH_CLEANUP_COMMAND_MAX_LENGTH ||
    policy.command.includes('\0') ||
    (policy.enabled && !policy.command.trim())
  ) {
    throw new Error(
      'Cleanup policy requires boolean settings and a command of at most 4096 characters (nonempty when enabled, no NUL)'
    );
  }
  return {
    enabled: policy.enabled,
    command: policy.command,
    allow_branch_protection: policy.allow_branch_protection,
  };
}

/** Policy and implementation availability; admission separately checks authority and activity. */
export function getBranchCleanupBlockReason(
  policy: RepoCleanupPolicy | null | undefined,
  protectedPreference: boolean
): string | undefined {
  const effective = resolveRepoCleanupPolicy(policy);
  if (!effective.enabled) return 'Cleanup is disabled for this repository.';
  if (effective.command !== DEFAULT_BRANCH_CLEANUP_COMMAND)
    return 'Custom cleanup commands are unavailable until descendant containment is supported. Use git clean -fdX.';
  if (effective.allow_branch_protection && protectedPreference)
    return 'This branch is protected from workspace cleanup.';
  return undefined;
}

export const BRANCH_CLEANUP_REPORT_SERVICE = 'branch-cleanup-steps';
export const branchCleanupCommandId = (executionId: string) =>
  `${BRANCH_CLEANUP_COMMAND}:${executionId}`;
export const BRANCH_WORKSPACE_OPERATION_BUDGET_MS = BRANCH_CLEANUP_TIMEOUT_MS + 60_000;
export const BRANCH_WORKSPACE_REPORT_ACTIONS = ['claim', 'succeeded', 'failed', 'unknown'] as const;
export type BranchWorkspaceReportAction = (typeof BRANCH_WORKSPACE_REPORT_ACTIONS)[number];

export interface BranchWorkspaceError {
  operation_id: import('./id').UUID;
  at: string;
  message: string;
}
export interface BranchWorkspaceOperation {
  operation_id: import('./id').UUID;
  action: 'clean' | 'archive';
  filesystem_action: import('./branch').BranchFilesystemAction;
  status: 'accepted' | 'running' | 'succeeded' | 'failed' | 'unknown';
  requested_by: import('./id').UserID;
  requested_at: string;
  deadline_at: string;
  started_at?: string;
  finished_at?: string;
  error?: string;
}
/** Private immutable targets, never returned by branch reads or accepted in patches. */
export interface BranchWorkspaceSnapshot {
  repo_id: import('./id').UUID;
  path: string;
  repo_path: string;
  policy?: RepoCleanupPolicy;
}
/** Standalone cleanup has exactly one filesystem action; archive chooses explicitly. */
export type BranchWorkspaceRequest =
  | { action: 'clean' }
  | { action: 'archive'; filesystemAction: import('./branch').BranchFilesystemAction };

export interface BranchCleanAccepted {
  branch_id: import('./id').BranchID;
  operation_id: import('./id').UUID;
  status: 'accepted';
}
/** A deadline diagnoses uncertainty; it NEVER releases ownership or permits replay. */
export function projectBranchWorkspaceOperation(
  operation: BranchWorkspaceOperation | undefined,
  now = Date.now()
): BranchWorkspaceOperation | undefined {
  if (
    operation &&
    ['accepted', 'running'].includes(operation.status) &&
    now >= Date.parse(operation.deadline_at)
  ) {
    return {
      ...operation,
      status: 'unknown',
      error:
        'Workspace operation stopped reporting. Its outcome requires reconciliation; do not retry.',
    };
  }
  return operation;
}

export const BRANCH_WORKSPACE_SERVER_FIELDS = [
  'workspace_snapshot',
  'workspace_operation',
  'cleanup_last_error',
  'last_cleanup_succeeded_at',
  'last_cleanup_operation_id',
] as const;
