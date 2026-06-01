/**
 * Repo List Utilities
 *
 * Generate flattened lists of repo references for UI selection
 */

import type { Branch, BranchName, Repo, RepoSlug } from '../types';

/**
 * Repo reference option for UI selection
 */
export interface RepoReferenceOption {
  /** Display label (e.g., "anthropics/agor:main" or "/Users/max/code/agor") */
  label: string;

  /** ID value for selection (repo_id or branch_id) */
  value: string;

  /** Reference type */
  type: 'path' | 'managed' | 'managed-branch';

  /** Repository slug (for managed repos) */
  slug?: RepoSlug;

  /** Branch name (for managed branches) */
  branch?: BranchName;

  /** Display description */
  description?: string;
}

/**
 * Generate a list of all repo reference options
 *
 * Creates options for:
 * - Each managed repo (bare repo)
 * - Each branch of each managed repo
 * - User paths can be added manually
 *
 * @param repos - List of Agor-managed repositories
 * @param branches - List of branches (optional, now fetched from branches table)
 * @returns Flattened list of selectable repo references
 *
 * @example
 * const options = getRepoReferenceOptions(repos, branches);
 * // [
 * //   { label: "anthropics/agor", value: "anthropics/agor", type: "managed", ... },
 * //   { label: "anthropics/agor:main", value: "anthropics/agor:main", type: "managed-branch", ... },
 * //   { label: "anthropics/agor:feat-auth", value: "anthropics/agor:feat-auth", type: "managed-branch", ... },
 * //   { label: "apache/superset", value: "apache/superset", type: "managed", ... },
 * //   { label: "apache/superset:main", value: "apache/superset:main", type: "managed-branch", ... },
 * // ]
 */
export function getRepoReferenceOptions(
  repos: Repo[],
  branches: Branch[] = []
): RepoReferenceOption[] {
  const options: RepoReferenceOption[] = [];

  // Create a map of repo_id to repo for fast lookups
  const repoMap = new Map(repos.map((repo) => [repo.repo_id, repo]));

  for (const repo of repos) {
    // Add bare repo option
    options.push({
      label: repo.slug,
      value: repo.repo_id, // Use repo_id as value
      type: 'managed',
      slug: repo.slug,
      description: `${repo.name} (bare repo)`,
    });
  }

  // Add branch options
  for (const branch of branches) {
    const repo = repoMap.get(branch.repo_id);
    if (!repo) continue; // Skip if repo not found

    const reference = `${repo.slug}:${branch.name}`;
    options.push({
      label: reference,
      value: branch.branch_id, // Use branch_id as value
      type: 'managed-branch',
      slug: repo.slug,
      branch: branch.name,
      description: `${repo.name} - ${branch.name} (${branch.ref})`,
    });
  }

  return options;
}

/**
 * Group repo reference options by repository
 *
 * Useful for hierarchical dropdowns/menus
 *
 * @param repos - List of Agor-managed repositories
 * @param branches - List of branches (optional, now fetched from branches table)
 * @returns Map of repo slug to options
 *
 * @example
 * const grouped = getGroupedRepoReferenceOptions(repos, branches);
 * // {
 * //   "anthropics/agor": [
 * //     { label: "anthropics/agor", ... },
 * //     { label: "anthropics/agor:main", ... },
 * //     { label: "anthropics/agor:feat-auth", ... },
 * //   ],
 * //   "apache/superset": [...]
 * // }
 */
export function getGroupedRepoReferenceOptions(
  repos: Repo[],
  branches: Branch[] = []
): Record<RepoSlug, RepoReferenceOption[]> {
  const grouped: Record<RepoSlug, RepoReferenceOption[]> = {};

  // Create a map of repo_id to repo for fast lookups
  const repoMap = new Map(repos.map((repo) => [repo.repo_id, repo]));

  for (const repo of repos) {
    const options: RepoReferenceOption[] = [];

    // Add bare repo option
    options.push({
      label: repo.slug,
      value: repo.repo_id, // Use repo_id as value
      type: 'managed',
      slug: repo.slug,
      description: `${repo.name} (bare repo)`,
    });

    grouped[repo.slug] = options;
  }

  // Add branch options to their respective repo groups
  for (const branch of branches) {
    const repo = repoMap.get(branch.repo_id);
    if (!repo) continue; // Skip if repo not found

    const reference = `${repo.slug}:${branch.name}`;
    if (!grouped[repo.slug]) {
      grouped[repo.slug] = [];
    }

    grouped[repo.slug].push({
      label: reference,
      value: branch.branch_id, // Use branch_id as value
      type: 'managed-branch',
      slug: repo.slug,
      branch: branch.name,
      description: `${repo.name} - ${branch.name} (${branch.ref})`,
    });
  }

  return grouped;
}

/**
 * Get default repo reference (first branch of first repo, or first repo)
 *
 * @param repos - List of Agor-managed repositories
 * @returns Default reference or undefined if no repos
 */
export function getDefaultRepoReference(repos: Repo[]): string | undefined {
  if (repos.length === 0) return undefined;

  const firstRepo = repos[0];

  // TODO: Update to fetch branches from branches table
  // For now, just return the bare repo
  return firstRepo.slug;
}
