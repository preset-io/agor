/**
 * Compatibility export for daemon-local operational git helpers.
 *
 * The implementation lives in @agor/git so daemon and executor callers do not
 * drift on ref validation, credential scrubbing, safe-directory handling, or
 * clone/worktree behavior.
 */
export * from '@agor/git';
