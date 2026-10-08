export type AgorAbortCause = 'coordinator_termination' | 'sdk_health_failure';

const abortCauses = new WeakMap<AbortController, AgorAbortCause>();
const cleanupUnverified = new WeakSet<AbortController>();

/** Sticky for this execution: a settled provider promise is not always proof of teardown. */
export function markExecutorCleanupUnverified(controller: AbortController): void {
  cleanupUnverified.add(controller);
}

export function isExecutorCleanupUnverified(controller: AbortController): boolean {
  return cleanupUnverified.has(controller);
}

export function markAgorAbortCause(controller: AbortController, cause: AgorAbortCause): void {
  abortCauses.set(controller, cause);
}

export function hasAgorAbortCause(controller: AbortController, cause: AgorAbortCause): boolean {
  return abortCauses.get(controller) === cause;
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
  return abortCauses.has(controller);
}
