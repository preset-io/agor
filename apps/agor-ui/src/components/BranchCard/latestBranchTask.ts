import type { Session, Task } from '@agor-live/client';
import { isGatewaySession, TaskStatus } from '@agor-live/client';

const ACTIVE_TASK_STATUSES = new Set<Task['status']>([
  TaskStatus.CREATED,
  TaskStatus.RUNNING,
  TaskStatus.STOPPING,
  TaskStatus.AWAITING_PERMISSION,
  TaskStatus.AWAITING_INPUT,
]);

const ACTIVE_SESSION_STATUSES = new Set<Session['status']>([
  'running',
  'stopping',
  'awaiting_permission',
  'awaiting_input',
]);

function timestamp(value: string | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

export function taskActivityTimestamp(task: Task): number {
  return Math.max(
    timestamp(task.last_executor_heartbeat_at),
    timestamp(task.completed_at),
    timestamp(task.message_range?.end_timestamp),
    timestamp(task.started_at),
    timestamp(task.message_range?.start_timestamp),
    timestamp(task.created_at)
  );
}

export function compareLatestTasks(a: Task, b: Task): number {
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

export function chooseLatestBranchTask(
  tasksBySession: Map<string, Task[]>,
  sessionById: Map<string, Session>
): { task: Task | null; session: Session | null } {
  const latestTask = Array.from(tasksBySession.values()).flat().sort(compareLatestTasks).at(-1);

  return {
    task: latestTask || null,
    session: latestTask ? sessionById.get(latestTask.session_id) || null : null,
  };
}

function compareSessionsByActivity(a: Session, b: Session): number {
  const aActive = ACTIVE_SESSION_STATUSES.has(a.status);
  const bActive = ACTIVE_SESSION_STATUSES.has(b.status);
  if (aActive !== bActive) return aActive ? 1 : -1;

  const updatedDiff = timestamp(a.last_updated) - timestamp(b.last_updated);
  if (updatedDiff !== 0) return updatedDiff;

  return timestamp(a.created_at) - timestamp(b.created_at);
}

function isManualSession(session: Session): boolean {
  return !session.scheduled_from_branch && !isGatewaySession(session);
}

export function chooseBranchPromptTargetSession({
  sessions,
  latestTaskSession,
  selectedSessionId,
}: {
  sessions: Session[];
  latestTaskSession: Session | null;
  selectedSessionId?: string | null;
}): Session | null {
  const activeSessions = sessions.filter((session) => !session.archived);

  if (selectedSessionId) {
    const selectedSession = activeSessions.find(
      (session) => session.session_id === selectedSessionId
    );
    if (selectedSession) return selectedSession;
  }

  if (latestTaskSession && !latestTaskSession.archived) {
    return latestTaskSession;
  }

  const manualSessions = activeSessions.filter(isManualSession).sort(compareSessionsByActivity);
  return manualSessions.at(-1) || activeSessions.sort(compareSessionsByActivity).at(-1) || null;
}
