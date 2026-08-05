import type { ExecutorFailureCause } from '@agor/core/types';

const DaemonAbortCause = {
  COORDINATOR_TERMINATION: 'coordinator_termination',
} as const;
type DaemonOwnedAbortCause = (typeof DaemonAbortCause)[keyof typeof DaemonAbortCause];

export interface InteractionAbortOutcome {
  cause: Extract<ExecutorFailureCause, 'interaction_unavailable' | 'interaction_timeout'>;
  errorMessage: string;
}

type AgorAbortDisposition =
  | {
      owner: 'daemon';
      cause: DaemonOwnedAbortCause;
    }
  | {
      owner: 'executor';
      outcome: InteractionAbortOutcome;
    };

const abortDispositions = new WeakMap<AbortController, AgorAbortDisposition>();

function markDaemonOwnedAbort(controller: AbortController, cause: DaemonOwnedAbortCause): void {
  abortDispositions.set(controller, { owner: 'daemon', cause });
}

function hasDaemonOwnedAbortCause(
  controller: AbortController,
  cause: DaemonOwnedAbortCause
): boolean {
  const disposition = abortDispositions.get(controller);
  return disposition?.owner === 'daemon' && disposition.cause === cause;
}

/** Mark an abort whose terminal task transition is owned by the daemon coordinator. */
export function markCoordinatorTerminationAbort(controller: AbortController): void {
  markDaemonOwnedAbort(controller, DaemonAbortCause.COORDINATOR_TERMINATION);
}

export function isCoordinatorTerminationAbort(controller: AbortController): boolean {
  return hasDaemonOwnedAbortCause(controller, DaemonAbortCause.COORDINATOR_TERMINATION);
}

/** Whether a daemon workflow, rather than the executor fail-safe, owns terminality. */
export function isDaemonOwnedAbort(controller: AbortController): boolean {
  return abortDispositions.get(controller)?.owner === 'daemon';
}

export function markInteractionAbort(
  controller: AbortController,
  outcome: InteractionAbortOutcome
): void {
  if (isDaemonOwnedAbort(controller)) return;
  abortDispositions.set(controller, { owner: 'executor', outcome });
  controller.abort();
}

export function getInteractionAbortOutcome(
  controller: AbortController
): InteractionAbortOutcome | undefined {
  const disposition = abortDispositions.get(controller);
  return disposition?.owner === 'executor' ? disposition.outcome : undefined;
}
