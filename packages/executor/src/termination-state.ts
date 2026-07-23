const coordinatorTerminationAborts = new WeakSet<AbortController>();

/** Mark an abort whose terminal task transition is owned by the daemon. */
export function markCoordinatorTerminationAbort(controller: AbortController): void {
  coordinatorTerminationAborts.add(controller);
}

export function isCoordinatorTerminationAbort(controller: AbortController): boolean {
  return coordinatorTerminationAborts.has(controller);
}
