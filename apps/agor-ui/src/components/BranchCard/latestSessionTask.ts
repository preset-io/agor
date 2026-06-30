import { isTaskExecuting } from '@agor/core/types';
import type { Task } from '@agor-live/client';
import { TaskStatus } from '@agor-live/client';

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
  const aActive = a.status === TaskStatus.CREATED || isTaskExecuting(a);
  const bActive = b.status === TaskStatus.CREATED || isTaskExecuting(b);
  if (aActive !== bActive) return aActive ? 1 : -1;

  const aQueued = a.status === TaskStatus.QUEUED;
  const bQueued = b.status === TaskStatus.QUEUED;
  if (aQueued !== bQueued) return aQueued ? -1 : 1;

  // Unstarted terminal tasks (legacy/admin cleanup rows with sentinel
  // start_index=-1) were never added to the transcript. Do not let them steal
  // the "latest task" peek from a task that actually ran.
  const aPinnedToTranscript = Boolean(a.started_at) || (a.message_range?.start_index ?? -1) >= 0;
  const bPinnedToTranscript = Boolean(b.started_at) || (b.message_range?.start_index ?? -1) >= 0;
  if (aPinnedToTranscript !== bPinnedToTranscript) return aPinnedToTranscript ? 1 : -1;

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
