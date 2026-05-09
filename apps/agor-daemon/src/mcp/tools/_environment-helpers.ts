import type { Repo } from '@agor/core/types';

/**
 * Validate a variant name against a repo's environment config.
 *
 * Throws with a helpful error message that lists the available variant names
 * (so the caller doesn't have to guess from documentation). Used by both
 * `agor_environment_set` and `agor_worktrees_create` to keep the error
 * shape consistent across the variant-aware MCP tools.
 */
export function assertValidVariant(repo: Repo, variant: string): void {
  const repoEnv = repo.environment;
  if (!repoEnv?.variants || !repoEnv.variants[variant]) {
    const available = repoEnv?.variants ? Object.keys(repoEnv.variants) : [];
    throw new Error(
      `Invalid variant "${variant}". ` +
        (available.length > 0
          ? `Available variants: ${available.join(', ')}`
          : 'This repo has no environment variants configured.')
    );
  }
}
