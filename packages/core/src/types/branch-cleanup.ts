/** Repository-approved executable configuration; never loaded from a branch checkout. */
export interface RepoCleanupPolicy {
  enabled: boolean;
  command: string;
  allow_branch_protection: boolean;
}

export const DEFAULT_BRANCH_CLEANUP_COMMAND = 'git clean -fdX';
export const BRANCH_CLEANUP_COMMAND_MAX_LENGTH = 4096;
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

/** Policy eligibility only: admission must additionally verify authority and quiescence. */
export function getBranchCleanupPolicyBlockReason(
  policy: RepoCleanupPolicy | null | undefined,
  protectedPreference: boolean
): string | undefined {
  const effective = resolveRepoCleanupPolicy(policy);
  if (!effective.enabled)
    return 'Cleanup is disabled for this repository. Archiving will keep workspace files on disk.';
  if (effective.allow_branch_protection && protectedPreference)
    return 'This branch is protected from workspace cleanup.';
  return undefined;
}
