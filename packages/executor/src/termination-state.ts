type DaemonOwnedAbortCause = 'coordinator_termination' | 'sdk_health_failure';
type InteractionAbortCause =
  | 'interaction_denied'
  | 'interaction_timeout'
  | 'interaction_unavailable'
  | 'interaction_error';
export type AgorAbortCause = DaemonOwnedAbortCause | InteractionAbortCause;

interface AgorAbortDisposition {
  cause: AgorAbortCause;
  message?: string;
}

const abortDispositions = new WeakMap<AbortController, AgorAbortDisposition>();

export function markAgorAbortCause(
  controller: AbortController,
  cause: AgorAbortCause,
  message?: string
): void {
  abortDispositions.set(controller, { cause, message });
}

export function hasAgorAbortCause(controller: AbortController, cause: AgorAbortCause): boolean {
  return abortDispositions.get(controller)?.cause === cause;
}

/** Mark an abort whose terminal task transition is owned by the daemon coordinator. */
export function markCoordinatorTerminationAbort(controller: AbortController): void {
  markAgorAbortCause(controller, 'coordinator_termination');
}

export function isCoordinatorTerminationAbort(controller: AbortController): boolean {
  return hasAgorAbortCause(controller, 'coordinator_termination');
}

/** Whether a daemon workflow, rather than the executor fail-safe, owns terminality. */
export function isDaemonOwnedAbort(controller: AbortController): boolean {
  const cause = abortDispositions.get(controller)?.cause;
  return cause === 'coordinator_termination' || cause === 'sdk_health_failure';
}

export function markInteractionAbort(
  controller: AbortController,
  cause: InteractionAbortCause,
  message: string
): void {
  markAgorAbortCause(controller, cause, message);
  controller.abort();
}

export function getInteractionAbortOutcome(
  controller: AbortController
): { status: 'failed' | 'timed_out'; errorMessage: string } | undefined {
  const disposition = abortDispositions.get(controller);
  if (!disposition?.cause.startsWith('interaction_')) return undefined;
  return {
    status: disposition.cause === 'interaction_timeout' ? 'timed_out' : 'failed',
    errorMessage: disposition.message ?? 'Agentic-tool interaction could not be completed',
  };
}
