import type { RepoCloneError } from '@agor/core/types';
import type { ExecutorExitResult, ExecutorProcessHandle } from './spawn-executor.js';

/** Conservative bound for full-history repo and self-standing branch clones. */
export const REPO_CLONE_TIMEOUT_MS = 30 * 60_000;
export const REPO_CLONE_CLEANUP_TIMEOUT_MS = 2 * 60_000;
export const REPO_CLONE_TIMEOUT_EXIT_CODE = 124;
export const REPO_CLONE_TOKEN_TTL_SECONDS = Math.ceil(
  (REPO_CLONE_TIMEOUT_MS + REPO_CLONE_CLEANUP_TIMEOUT_MS + 60_000) / 1_000
);

type CloneSupervisorState = 'running' | 'timing_out' | 'cancelling' | 'exited';

export interface RepoCloneTimeoutContext {
  error: RepoCloneError;
  cleanupError?: string;
  terminationError?: string;
}

export interface SuperviseRepoCloneOptions {
  process: ExecutorProcessHandle;
  timeoutMs?: number;
  cleanupPartialClone(): Promise<void>;
  onExit(exit: ExecutorExitResult): Promise<void>;
  onTimeout(context: RepoCloneTimeoutContext): Promise<void>;
}

export interface RepoCloneSupervisor {
  readonly completion: Promise<'exited' | 'timed_out' | 'cancelled'>;
  /** Re-check/terminate the owned tree after a previous containment failure. */
  ensureTerminated(): Promise<void>;
  /**
   * Explicit user cancellation. Returns false if process exit or timeout
   * already won the lifecycle race.
   */
  cancel(): Promise<boolean>;
}

type CloneOperationKind = 'repo' | 'branch';

const activeCloneOperations = new Map<string, RepoCloneSupervisor>();

function cloneOperationKey(kind: CloneOperationKind, id: string): string {
  return `${kind}:${id}`;
}

/**
 * Track clone ownership across the repos and branches services. Branch
 * creation lives on ReposService while branch deletion lives on
 * BranchesService, so a module-level registry is the smallest shared
 * cancellation boundary.
 */
export function trackCloneOperation(
  kind: CloneOperationKind,
  id: string,
  supervisor: RepoCloneSupervisor
): void {
  const key = cloneOperationKey(kind, id);
  activeCloneOperations.set(key, supervisor);
  const removeIfCurrent = (): void => {
    if (activeCloneOperations.get(key) === supervisor) {
      activeCloneOperations.delete(key);
    }
  };
  void supervisor.completion.then(
    (result) => {
      // Cancellation removes the entry only after cancel() itself has
      // confirmed tree termination. A rejected containment attempt
      // deliberately remains registered so a later delete can retry instead
      // of touching live files.
      if (result !== 'cancelled') removeIfCurrent();
    },
    () => undefined
  );
}

/**
 * Cancel a tracked clone and await its terminal path. A timeout which already
 * won is awaited rather than reclassified as an explicit cancellation.
 */
export async function cancelTrackedCloneOperation(
  kind: CloneOperationKind,
  id: string
): Promise<boolean> {
  const supervisor = activeCloneOperations.get(cloneOperationKey(kind, id));
  if (!supervisor) return false;

  const cancelled = await supervisor.cancel();
  if (cancelled) {
    if (activeCloneOperations.get(cloneOperationKey(kind, id)) === supervisor) {
      activeCloneOperations.delete(cloneOperationKey(kind, id));
    }
    return true;
  }

  try {
    await supervisor.completion;
  } catch {
    // A prior timeout/exit failed to prove containment. Retry before allowing
    // the caller to preserve or remove the partial directory.
    await supervisor.ensureTerminated();
    if (activeCloneOperations.get(cloneOperationKey(kind, id)) === supervisor) {
      activeCloneOperations.delete(cloneOperationKey(kind, id));
    }
  }
  return true;
}

function formatTimeout(timeoutMs: number): string {
  if (timeoutMs % 60_000 === 0) {
    const minutes = timeoutMs / 60_000;
    return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  }
  if (timeoutMs % 1_000 === 0) {
    const seconds = timeoutMs / 1_000;
    return `${seconds} second${seconds === 1 ? '' : 's'}`;
  }
  return `${timeoutMs}ms`;
}

export function buildRepoCloneTimeoutError(
  timeoutMs: number,
  details: { cleanupError?: string; terminationError?: string } = {}
): RepoCloneError {
  const prefix = `Clone timed out after ${formatTimeout(timeoutMs)}.`;

  if (details.terminationError) {
    return {
      exit_code: REPO_CLONE_TIMEOUT_EXIT_CODE,
      category: 'timeout',
      message:
        `${prefix} Failed to confirm termination of the clone process tree: ` +
        `${details.terminationError}. Partial checkout cleanup was skipped because files cannot ` +
        'be removed safely while clone processes may still be running.',
    };
  }

  if (details.cleanupError) {
    return {
      exit_code: REPO_CLONE_TIMEOUT_EXIT_CODE,
      category: 'timeout',
      message:
        `${prefix} The clone process tree was terminated, but partial checkout cleanup failed: ` +
        `${details.cleanupError}. Manual cleanup may be required.`,
    };
  }

  return {
    exit_code: REPO_CLONE_TIMEOUT_EXIT_CODE,
    category: 'timeout',
    message: `${prefix} The clone process tree was terminated and the partial checkout was removed.`,
  };
}

/**
 * Own the terminal-state race for one remote-repository clone.
 *
 * The state transition happens synchronously when timeout/cancellation wins,
 * before any awaited work. Therefore a late executor-exit callback cannot
 * reinterpret a timed-out clone as a normal completion. Timeout handling
 * waits for the complete process tree before touching the partial checkout.
 */
export function superviseRepoClone(options: SuperviseRepoCloneOptions): RepoCloneSupervisor {
  const timeoutMs = options.timeoutMs ?? REPO_CLONE_TIMEOUT_MS;
  let state: CloneSupervisorState = 'running';
  let resolveTimeout!: () => void;

  const timeoutPromise = new Promise<void>((resolve) => {
    resolveTimeout = resolve;
  });

  const timer = setTimeout(() => {
    if (state !== 'running') return;
    state = 'timing_out';
    resolveTimeout();
  }, timeoutMs);

  const processExitPromise = options.process.completion.then((exit) => {
    const stateAtExit = state;
    if (state === 'running') state = 'exited';
    return { exit, stateAtExit };
  });

  const completion = (async (): Promise<'exited' | 'timed_out' | 'cancelled'> => {
    const winner = await Promise.race([
      processExitPromise.then((result) => ({ kind: 'process' as const, result })),
      timeoutPromise.then(() => ({ kind: 'timeout' as const })),
    ]);

    if (winner.kind === 'process') {
      clearTimeout(timer);
      if (winner.result.stateAtExit === 'cancelling') return 'cancelled';
      if (winner.result.stateAtExit === 'timing_out') {
        // The timeout branch owns cleanup/error persistence. Its promise was
        // resolved before termination began and will win the race in practice;
        // retaining this guard makes that ownership explicit.
        return 'timed_out';
      }

      // The direct executor can exit while a git transport/index-pack child
      // remains alive in its detached process group (the orphan observed in
      // #2030). A normal exit owns no long-lived descendants, so quiesce and
      // await the group before running either success or ordinary-failure
      // handling. This does not reinterpret the exit as a timeout and does
      // not remove failure artifacts.
      let descendantTerminationError: unknown;
      try {
        await options.process.terminate();
      } catch (error) {
        descendantTerminationError = error;
      }
      await options.onExit(winner.result.exit);
      if (descendantTerminationError) throw descendantTerminationError;
      return 'exited';
    }

    let terminationError: string | undefined;
    try {
      await options.process.terminate();
    } catch (error) {
      terminationError = error instanceof Error ? error.message : String(error);
    }

    let cleanupError: string | undefined;
    if (!terminationError) {
      try {
        await options.cleanupPartialClone();
      } catch (error) {
        cleanupError = error instanceof Error ? error.message : String(error);
      }
    }

    const error = buildRepoCloneTimeoutError(timeoutMs, { cleanupError, terminationError });
    await options.onTimeout({ error, cleanupError, terminationError });
    if (terminationError) throw new Error(error.message);
    return 'timed_out';
  })();

  return {
    completion,
    ensureTerminated: () => options.process.terminate(),
    async cancel(): Promise<boolean> {
      if (state !== 'running') return false;
      state = 'cancelling';
      clearTimeout(timer);
      await options.process.terminate();
      await completion;
      return true;
    },
  };
}
