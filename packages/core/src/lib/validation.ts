/**
 * Validation Utilities
 *
 * Shared validation functions used across all agent tools.
 */

import * as fs from 'node:fs/promises';

/**
 * Validate that a directory exists and is accessible
 *
 * @param path - Directory path to validate
 * @param context - Optional context string for error messages (e.g., "CWD", "worktree path")
 * @throws Error if directory doesn't exist or is not a directory
 */
export async function validateDirectory(path: string, context = 'Directory'): Promise<void> {
  try {
    const stats = await fs.stat(path);
    if (!stats.isDirectory()) {
      throw new Error(`${context} exists but is not a directory: ${path}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`${context} does not exist: ${path}`);
    }
    throw new Error(`${context} is not accessible: ${path} (${error})`);
  }
}

/**
 * @deprecated Use FeathersJS schema validation instead
 * Import from '@agor/core/lib/feathers-validation'
 */
