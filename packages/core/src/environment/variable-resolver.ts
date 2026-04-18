/**
 * Environment variable resolution for worktrees
 *
 * Handles auto-assignment of WORKTREE_UNIQUE_ID and building
 * Handlebars context from worktree + repo config.
 */

import { buildWorktreeContext } from '../templates/handlebars-helpers';
import type { WorktreeEnvironmentInstance } from '../types';

/**
 * Auto-assign WORKTREE_UNIQUE_ID for a new worktree
 *
 * Strategy:
 * - Start at 1 and increment by 1 for each worktree
 * - Skip IDs that are already in use (including archived worktrees)
 * - Returns a unique ID for this worktree
 *
 * IMPORTANT: The input MUST include IDs from ALL worktrees (including archived ones).
 * Archived worktrees still hold their unique IDs for environment template consistency.
 *
 * @param usedIds - All worktree_unique_id values currently in use (including archived)
 * @returns Unique ID number (e.g., 1, 2, 3, ...)
 */
export function autoAssignWorktreeUniqueId(usedIds: number[]): number {
  const usedSet = new Set<number>(usedIds);

  // Find next available ID starting from 1
  let id = 1;
  while (usedSet.has(id)) {
    id++;
  }

  return id;
}

/**
 * Initialize environment instance for a new worktree
 *
 * Creates WorktreeEnvironmentInstance with default stopped status.
 * No variables needed - all template vars come from worktree built-ins
 * (WORKTREE_UNIQUE_ID, etc.) and custom_context.
 *
 * @returns New environment instance
 */
export function initializeEnvironmentInstance(): WorktreeEnvironmentInstance {
  return {
    status: 'stopped',
    process: undefined,
    last_health_check: undefined,
    access_urls: undefined,
    logs: undefined,
  };
}

/**
 * Build template context for environment commands
 *
 * Combines built-in variables (WORKTREE_UNIQUE_ID, WORKTREE_NAME, WORKTREE_PATH, REPO_SLUG)
 * with user-defined custom_context.
 *
 * @param worktree - Worktree object
 * @param repoSlug - Repository slug
 * @returns Handlebars context object
 */
export function buildEnvironmentContext(
  worktree: {
    worktree_unique_id: number;
    name: string;
    path: string;
    custom_context?: Record<string, unknown>;
  },
  repoSlug: string,
  hostIpAddress?: string
): Record<string, unknown> {
  return buildWorktreeContext({
    worktree_unique_id: worktree.worktree_unique_id,
    name: worktree.name,
    path: worktree.path,
    repo_slug: repoSlug,
    custom_context: worktree.custom_context,
    host_ip_address: hostIpAddress,
  });
}
