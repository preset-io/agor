import { EXECUTOR_RESULT_PREFIX } from '@agor/core/executor-protocol';

export function emitExecutorResult(result: unknown): void {
  console.log(`${EXECUTOR_RESULT_PREFIX}${JSON.stringify(result)}`);
}

export function completeExecutorResult<T extends { success: boolean }>(result: T): void {
  const code = result.success ? 0 : 1;
  const line = `${EXECUTOR_RESULT_PREFIX}${JSON.stringify(result)}\n`;
  process.exitCode = code;
  // Force-exit once the (possibly piped) stdout has flushed. Setting exitCode alone
  // is not enough for one-shot commands: lingering handles (daemon WS clients,
  // socket.io timers) keep the event loop alive, so the process would hang until the
  // daemon's 60s timeout. Writing then exiting in the drain callback flushes the full
  // result (even past the 64KB pipe buffer) AND terminates deterministically.
  process.stdout.write(line, () => process.exit(code));
  // Failsafe for the rare case the write callback never fires (e.g. stdout wedged
  // without erroring). A failed/EPIPE write still invokes the callback (with an error
  // we ignore) and exits, so this only covers the truly-stuck case. 5s is generous
  // enough that a legitimately slow reader always finishes flushing first, yet well
  // under the daemon's 60s executor timeout. unref() so this timer can't keep us alive.
  setTimeout(() => process.exit(code), 5000).unref();
}
