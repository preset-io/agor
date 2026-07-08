import type { Params, TaskRuntimeEvent, TaskRuntimeVitals } from '@agor/core/types';
import { type Task, TaskRuntimeEventKind, TaskRuntimePhase, TaskStatus } from '@agor/core/types';

const DEFAULT_MAX_EVENTS = 20;
const CLEARED_ACTIVE_TOOL = null as unknown as TaskRuntimeVitals['active_tool'];
const ALLOWED_DAEMON_ERROR_CODES = new Set([
  'cwd_missing',
  'spawn_error',
  'spawn_exception',
  'unexpected_exit',
  'unknown',
]);

type TasksRuntimeVitalsService = {
  get(id: string, params?: Params): Promise<Task>;
  patch(id: string, data: Partial<Task>, params?: Params): Promise<Task>;
};

export interface DaemonRuntimeVitalsEventOptions {
  at?: Date | string;
  phase?: TaskRuntimeVitals['phase'];
  processPid?: number;
  exitCode?: number | null;
  errorCode?: string;
  maxEvents?: number;
}

function toIsoTimestamp(input: Date | string | undefined): string {
  if (!input) return new Date().toISOString();
  return input instanceof Date ? input.toISOString() : input;
}

function sanitizePositiveInteger(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isSafeInteger(value) || value <= 0) return undefined;
  return value;
}

function sanitizeExitCode(value: number | null | undefined): number | null | undefined {
  if (value === null) return null;
  if (value === undefined) return undefined;
  return Number.isSafeInteger(value) ? value : undefined;
}

function sanitizeErrorCode(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return ALLOWED_DAEMON_ERROR_CODES.has(value) ? value : 'unknown';
}

function isTerminalPhase(phase: TaskRuntimeVitals['phase']): boolean {
  return (
    phase === TaskRuntimePhase.COMPLETED ||
    phase === TaskRuntimePhase.FAILED ||
    phase === TaskRuntimePhase.STOPPED ||
    phase === TaskRuntimePhase.TIMED_OUT
  );
}

export function taskStatusToDaemonRuntimePhase(
  status: TaskStatus | undefined
): TaskRuntimeVitals['phase'] | undefined {
  switch (status) {
    case TaskStatus.RUNNING:
      return TaskRuntimePhase.RUNNING;
    case TaskStatus.STOPPING:
      return TaskRuntimePhase.STOPPING;
    case TaskStatus.AWAITING_PERMISSION:
      return TaskRuntimePhase.AWAITING_PERMISSION;
    case TaskStatus.COMPLETED:
      return TaskRuntimePhase.COMPLETED;
    case TaskStatus.FAILED:
      return TaskRuntimePhase.FAILED;
    case TaskStatus.STOPPED:
      return TaskRuntimePhase.STOPPED;
    case TaskStatus.TIMED_OUT:
      return TaskRuntimePhase.TIMED_OUT;
    default:
      return undefined;
  }
}

export function buildDaemonTaskRuntimeVitals(
  previous: TaskRuntimeVitals | undefined,
  kind: TaskRuntimeEventKind,
  options: DaemonRuntimeVitalsEventOptions = {}
): TaskRuntimeVitals {
  const at = toIsoTimestamp(options.at);
  const phase = options.phase ?? previous?.phase ?? TaskRuntimePhase.RUNNING;
  const phaseChanged = !previous || previous.phase !== phase;
  const maxEvents = Math.max(1, Math.floor(options.maxEvents ?? DEFAULT_MAX_EVENTS));
  const processPid = sanitizePositiveInteger(options.processPid);
  const exitCode = sanitizeExitCode(options.exitCode);
  const errorCode = sanitizeErrorCode(options.errorCode);

  const event: TaskRuntimeEvent = {
    kind,
    at,
    source: 'daemon',
    phase,
    ...(processPid !== undefined ? { process_pid: processPid } : {}),
    ...(exitCode !== undefined ? { exit_code: exitCode } : {}),
    ...(errorCode ? { error_code: errorCode } : {}),
  };

  const previousCounters = previous?.counters ?? {};
  const counters: NonNullable<TaskRuntimeVitals['counters']> = {
    ...previousCounters,
    events: (previousCounters.events ?? 0) + 1,
  };

  const recent_events = [...(previous?.recent_events ?? []), event].slice(-maxEvents);
  const shouldClearActiveTool =
    isTerminalPhase(phase) || kind === TaskRuntimeEventKind.EXECUTOR_SPAWN_FAILED;
  const active_tool = shouldClearActiveTool ? CLEARED_ACTIVE_TOOL : previous?.active_tool;

  return {
    schema_version: 1,
    phase,
    phase_started_at: phaseChanged ? at : (previous?.phase_started_at ?? at),
    last_activity_at: at,
    ...(previous?.last_meaningful_progress_at
      ? { last_meaningful_progress_at: previous.last_meaningful_progress_at }
      : {}),
    ...(previous?.first_meaningful_progress_at
      ? { first_meaningful_progress_at: previous.first_meaningful_progress_at }
      : {}),
    last_event: event,
    ...(active_tool !== undefined ? { active_tool } : {}),
    counters,
    recent_events,
  };
}

export async function patchDaemonTaskRuntimeEvent(
  tasksService: TasksRuntimeVitalsService,
  taskId: string,
  kind: TaskRuntimeEventKind,
  options: DaemonRuntimeVitalsEventOptions = {},
  params?: Params
): Promise<TaskRuntimeVitals | undefined> {
  try {
    const task = await tasksService.get(taskId, params);
    if (task.current_execution_attempt?.terminal_at) {
      return undefined;
    }
    const phase =
      options.phase ?? task.runtime_vitals?.phase ?? taskStatusToDaemonRuntimePhase(task.status);
    const runtime_vitals = buildDaemonTaskRuntimeVitals(task.runtime_vitals, kind, {
      ...options,
      phase,
    });
    await tasksService.patch(taskId, { runtime_vitals }, params);
    return runtime_vitals;
  } catch (error) {
    console.warn(
      '[runtime-vitals] Failed to write daemon task runtime vitals:',
      error instanceof Error ? error.message : String(error)
    );
    return undefined;
  }
}
