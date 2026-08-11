import { EXECUTOR_RESULT_PREFIX } from '@agor/core/executor-protocol';

export function emitExecutorResult(result: unknown): void {
  console.log(`${EXECUTOR_RESULT_PREFIX}${JSON.stringify(result)}`);
}

export function completeExecutorResult<T extends { success: boolean }>(result: T): void {
  const code = result.success ? 0 : 1;
  const line = `${EXECUTOR_RESULT_PREFIX}${JSON.stringify(result)}\n`;
  // Emit the full result, then force-exit — but ONLY from the write callback, i.e. once
  // stdout has actually flushed. Two failure modes this threads between:
  //   * Truncation: console.log to a pipe is async on Linux; a bare process.exit() drops
  //     anything past the 64KB kernel pipe buffer. Exiting in the write callback instead
  //     guarantees the whole result reached the kernel, even for a slow/backpressured
  //     reader that takes a while to drain.
  //   * Hang: one-shot commands leave a Feathers/socket.io client open whose timers keep
  //     the event loop alive, so `process.exitCode = code` alone never terminates. The
  //     callback exit tears the process down despite those lingering handles.
  //
  // Deliberately NO wall-clock failsafe: any timer short enough to be useful is also
  // short enough to fire mid-flush under backpressure and re-truncate the result — the
  // exact bug this function prevents. If stdout is genuinely wedged and the callback
  // never fires, the daemon's existing 60s executor supervisor is the correct place to
  // enforce a deadline (it reports a timeout rather than a false success-with-truncation).
  process.exitCode = code;
  process.stdout.write(line, () => process.exit(code));
}
