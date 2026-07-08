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

export interface ExecutorConnectionEvidenceState {
  has_current_attempt?: boolean;
  connected_at?: unknown;
  last_heartbeat_at?: unknown;
  task_last_executor_heartbeat_at?: unknown;
}

export function hasExecutorConnectionEvidence(state: ExecutorConnectionEvidenceState): boolean {
  if (state.has_current_attempt) {
    return Boolean(state.connected_at || state.last_heartbeat_at);
  }
  return Boolean(
    state.connected_at || state.last_heartbeat_at || state.task_last_executor_heartbeat_at
  );
}

export interface CommandTemplateLauncherExitState {
  code: number | null;
  connected: boolean;
  activeTask: boolean;
  isLatestTask: boolean;
  sessionExecuting: boolean;
}

export function shouldFailCommandTemplateLauncherExit(
  state: CommandTemplateLauncherExitState
): boolean {
  return (
    state.code !== 0 &&
    !state.connected &&
    state.activeTask &&
    state.isLatestTask &&
    state.sessionExecuting
  );
}

export interface CommandTemplateConnectTimeoutState extends CommandTemplateLauncherExitState {
  attemptMatches: boolean;
}

export function shouldScheduleCommandTemplateConnectTimeout(
  state: CommandTemplateConnectTimeoutState
): boolean {
  return (
    state.attemptMatches &&
    state.code === 0 &&
    !state.connected &&
    state.activeTask &&
    state.isLatestTask &&
    state.sessionExecuting
  );
}
