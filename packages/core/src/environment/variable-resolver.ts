/**
 * Environment variable resolution for branches
 *
 * Handles auto-assignment of BRANCH_UNIQUE_ID and building
 * Handlebars context from branch + repo config.
 */

import { buildBranchContext } from '../templates/handlebars-helpers';
import type { BranchEnvironmentInstance } from '../types';

/**
 * Auto-assign BRANCH_UNIQUE_ID for a new branch
 *
 * Strategy:
 * - Start at 1 and increment by 1 for each branch
 * - Skip IDs that are already in use (including archived branches)
 * - Returns a unique ID for this branch
 *
 * IMPORTANT: The input MUST include IDs from ALL branches (including archived ones).
 * Archived branches still hold their unique IDs for environment template consistency.
 *
 * @param usedIds - All branch_unique_id values currently in use (including archived)
 * @returns Unique ID number (e.g., 1, 2, 3, ...)
 */
export function autoAssignBranchUniqueId(usedIds: number[]): number {
  const usedSet = new Set<number>(usedIds);

  // Find next available ID starting from 1
  let id = 1;
  while (usedSet.has(id)) {
    id++;
  }

  return id;
}

/**
 * Initialize environment instance for a new branch
 *
 * Creates BranchEnvironmentInstance with default stopped status.
 * No variables needed - all template vars come from branch built-ins
 * (BRANCH_UNIQUE_ID, etc.) and custom_context.
 *
 * @returns New environment instance
 */
export function initializeEnvironmentInstance(): BranchEnvironmentInstance {
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
 * Combines built-in variables (BRANCH_UNIQUE_ID, BRANCH_NAME, BRANCH_PATH, REPO_SLUG)
 * with user-defined custom_context.
 *
 * @param branch - Branch object
 * @param repoSlug - Repository slug
 * @returns Handlebars context object
 */
export function buildEnvironmentContext(
  branch: {
    branch_unique_id: number;
    name: string;
    path: string;
    custom_context?: Record<string, unknown>;
  },
  repoSlug: string,
  hostIpAddress?: string
): Record<string, unknown> {
  return buildBranchContext({
    branch_unique_id: branch.branch_unique_id,
    name: branch.name,
    path: branch.path,
    repo_slug: repoSlug,
    custom_context: branch.custom_context,
    host_ip_address: hostIpAddress,
  });
}
