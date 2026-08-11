export const EXECUTOR_RESULT_PREFIX = 'AGOR_EXECUTOR_RESULT ';

export function emitExecutorResult(result: unknown): void {
  console.log(`${EXECUTOR_RESULT_PREFIX}${JSON.stringify(result)}`);
}
