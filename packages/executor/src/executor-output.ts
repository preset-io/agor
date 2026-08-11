import { EXECUTOR_RESULT_PREFIX } from '@agor/core/executor-protocol';

export function emitExecutorResult(result: unknown): void {
  console.log(`${EXECUTOR_RESULT_PREFIX}${JSON.stringify(result)}`);
}

export function completeExecutorResult<T extends { success: boolean }>(result: T): void {
  const code = result.success ? 0 : 1;
  const line = `${EXECUTOR_RESULT_PREFIX}${JSON.stringify(result)}\n`;
  process.exitCode = code;
  // Write the sentinel, then force-exit once it has flushed to the (possibly piped) stdout.
  // Lingering handles such as WebSocket timers must not keep one-shot executors alive.
  process.stdout.write(line, () => process.exit(code));
  // If the flush callback never fires (for example, the reader closed the pipe), still exit.
  setTimeout(() => process.exit(code), 1000).unref();
}
