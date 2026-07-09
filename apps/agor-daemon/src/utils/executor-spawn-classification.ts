import type { ChildProcess } from 'node:child_process';
import {
  type TaskRuntimeEvent,
  TaskRuntimeEventKind,
  type TaskRuntimeVitals,
} from '@agor/core/types';

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

function runtimeEvents(vitals: TaskRuntimeVitals | undefined): TaskRuntimeEvent[] {
  if (!vitals) return [];
  return [vitals.last_event, ...(vitals.recent_events ?? [])].filter(
    (event): event is TaskRuntimeEvent => event !== undefined
  );
}

/**
 * Command-template launchers are only submission processes. The real executor
 * is proven by executor/sdk/tool/permission events that can only come from the
 * authenticated runtime after it connects back to the daemon.
 */
export function hasExecutorRuntimeEvidence(vitals: TaskRuntimeVitals | undefined): boolean {
  return runtimeEvents(vitals).some(
    (event) =>
      event.kind === TaskRuntimeEventKind.EXECUTOR_CONNECTED ||
      event.source === 'executor' ||
      event.source === 'sdk' ||
      event.source === 'tool' ||
      event.source === 'permission'
  );
}

export interface ChildExitFailureClassification {
  usesCommandTemplate: boolean;
  code: number | null;
  localExecutorProcessObserved: boolean;
  executorRuntimeObserved: boolean;
}

/**
 * Local child exit before terminal state means the executor was lost. In
 * command-template mode the child is just a launcher: only a non-zero launcher
 * exit before executor connection is authoritative as spawn failure.
 */
export function shouldFailTaskForChildExit({
  usesCommandTemplate,
  code,
  localExecutorProcessObserved,
  executorRuntimeObserved,
}: ChildExitFailureClassification): boolean {
  if (usesCommandTemplate) {
    return !executorRuntimeObserved && code !== 0;
  }
  return localExecutorProcessObserved || code !== 0;
}
