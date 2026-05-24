/**
 * Git helpers that may spawn git or touch managed repo/worktree directories.
 * Daemon code should not import this module for managed-dir operations; route
 * those through packages/executor instead.
 */
export * from './index';
