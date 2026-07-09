import type { ChildProcess } from 'node:child_process';

/**
 * `child_process.spawn()` returns a ChildProcess before the launch outcome is
 * fully known. Spawn failures can still emit `error` after callers receive the
 * object, and those failures commonly have no child PID.
 */
export function hasObservedLaunchedExecutorProcess(child: Pick<ChildProcess, 'pid'>): boolean {
  return typeof child.pid === 'number' && Number.isSafeInteger(child.pid) && child.pid > 0;
}

export function isExecutorSpawnFailureExit(processSpawnObserved: boolean, code: number | null) {
  return !processSpawnObserved && code !== 0;
}

export interface ChildExitFailureClassification {
  usesCommandTemplate: boolean;
  code: number | null;
  localExecutorProcessObserved: boolean;
}

/**
 * Local child exit before terminal state means the executor was lost. In
 * command-template mode the child is just a launcher/submission process, so
 * this passive daemon vitals path must not treat launcher exit as authoritative
 * task completion. Spawn/connect timeout policy should use authoritative
 * lifecycle fields (for example executor connection/heartbeat fencing), not
 * runtime_vitals observations.
 */
export function shouldFailTaskForChildExit({
  usesCommandTemplate,
  code,
  localExecutorProcessObserved,
}: ChildExitFailureClassification): boolean {
  if (usesCommandTemplate) {
    return false;
  }
  return localExecutorProcessObserved || code !== 0;
}
