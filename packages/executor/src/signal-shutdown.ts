import type { ExecutorInterruptionInput } from '@agor/core/types';

// Leave room inside the usual remote termination grace for the launcher to
// observe exit. This is a total budget, including cleanup and daemon I/O.
export const EXECUTOR_SIGNAL_GRACE_MS = 10_000;

/** One bounded shutdown, even if TERM/INT arrive repeatedly during cleanup. */
export function createExecutorSignalShutdown(options: {
  shutdown: (signal: ExecutorInterruptionInput['signal'], deadline: AbortSignal) => Promise<void>;
  exit: (code: number) => void;
  warn: (message: string) => void;
  graceMs?: number;
}): (signal: ExecutorInterruptionInput['signal']) => Promise<void> {
  let shutdown: Promise<void> | undefined;
  return (signal) => {
    if (shutdown) return shutdown;
    const deadline = new AbortController();
    const code = signal === 'SIGTERM' ? 143 : 130;
    shutdown = new Promise<void>((resolve) => {
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        deadline.abort();
        options.exit(code);
        resolve();
      };
      // Keep this referenced: a stuck provider or disconnected daemon must not
      // turn the signal handler into an unbounded shutdown promise.
      const timer = setTimeout(() => {
        options.warn('[executor.signal] event=deadline_exceeded containment=unverified');
        finish();
      }, options.graceMs ?? EXECUTOR_SIGNAL_GRACE_MS);
      void options.shutdown(signal, deadline.signal).then(finish, () => {
        if (finished) return;
        options.warn('[executor.signal] event=report_failed containment=unverified');
        finish();
      });
    });
    return shutdown;
  };
}
