import { EXECUTOR_RESULT_PREFIX } from '@agor/core/executor-protocol';

export function emitExecutorResult(result: unknown): void {
  console.log(`${EXECUTOR_RESULT_PREFIX}${JSON.stringify(result)}`);
}

export function completeExecutorResult<T extends { success: boolean }>(result: T): void {
  emitExecutorResult(result);
  // Assigning exitCode lets Node drain piped stdout before the event loop exits.
  process.exitCode = result.success ? 0 : 1;
}
