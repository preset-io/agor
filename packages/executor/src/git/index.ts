/**
 * Executor-facing operational git helpers.
 *
 * The implementation lives in @agor/git so executor and daemon compatibility
 * paths share one audited implementation instead of drifting copies.
 */
export * from '@agor/git';
