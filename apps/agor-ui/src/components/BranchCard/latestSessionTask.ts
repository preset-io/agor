import type { Task } from '@agor-live/client';
import { TaskStatus } from '@agor-live/client';

const ACTIVE_TASK_STATUSES = new Set<Task['status']>([
  TaskStatus.CREATED,
  TaskStatus.RUNNING,
  TaskStatus.STOPPING,
  TaskStatus.AWAITING_PERMISSION,
  TaskStatus.AWAITING_INPUT,
]);

function timestamp(value: string | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function taskActivityTimestamp(task: Task): number {
  return Math.max(
    timestamp(task.last_executor_heartbeat_at),
    timestamp(task.completed_at),
    timestamp(task.message_range?.end_timestamp),
    timestamp(task.started_at),
    timestamp(task.message_range?.start_timestamp),
    timestamp(task.created_at)
  );
}

function compareLatestTasks(a: Task, b: Task): number {
  const aActive = ACTIVE_TASK_STATUSES.has(a.status);
  const bActive = ACTIVE_TASK_STATUSES.has(b.status);
  if (aActive !== bActive) return aActive ? 1 : -1;

  const aQueued = a.status === TaskStatus.QUEUED;
  const bQueued = b.status === TaskStatus.QUEUED;
  if (aQueued !== bQueued) return aQueued ? -1 : 1;

  const activityDiff = taskActivityTimestamp(a) - taskActivityTimestamp(b);
  if (activityDiff !== 0) return activityDiff;

  return a.created_at.localeCompare(b.created_at);
}

export function chooseLatestSessionTask(tasks: Task[]): Task | null {
  const taskById = new Map<string, Task>();
  for (const task of tasks) {
    taskById.set(task.task_id, task);
  }
  return Array.from(taskById.values()).sort(compareLatestTasks).at(-1) || null;
}
