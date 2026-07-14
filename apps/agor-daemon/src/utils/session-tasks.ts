/**
 * Helpers for finding "active" tasks for a session — DISPATCHING / RUNNING / STOPPING /
 * AWAITING_PERMISSION / AWAITING_INPUT — sorted by recency.
 *
 * Centralizes the session query and recency ordering shared by Stop and widget
 * hosting so those callers do not rebuild subtly different task selection.
 */

import type { Application } from '@agor/core/feathers';
import type { Paginated, Params, SessionID, Task } from '@agor/core/types';
import { EXECUTING_TASK_STATUSES, isTaskExecuting } from '@agor/core/types';

function recencyKey(t: Task): number {
  return new Date(t.started_at || t.created_at).getTime();
}

/**
 * All tasks for the session, returned in recency-DESC order (most recently
 * started/created first). Useful when callers want a fallback path.
 */
async function findTasksForSession(
  app: Application,
  sessionId: SessionID,
  params?: Params,
  statuses?: ReadonlySet<Task['status']>
): Promise<Task[]> {
  const result = (await app.service('tasks').find({
    ...(params ?? {}),
    // Merge defensively: spread params first, then force session_id so a
    // caller-supplied params.query can never silently overwrite the filter.
    query: {
      ...(params?.query as Record<string, unknown> | undefined),
      session_id: sessionId,
      ...(statuses ? { status: { $in: [...statuses] } } : {}),
      $limit: (params?.query as Record<string, unknown> | undefined)?.$limit ?? 1000,
    },
  })) as Paginated<Task> | Task[];
  const tasks = Array.isArray(result) ? result : result.data;
  return [...tasks].sort((a, b) => recencyKey(b) - recencyKey(a));
}

/**
 * The session's active/executor-owned tasks,
 * recency-DESC. Empty when nothing is active.
 */
export async function findActiveTasksForSession(
  app: Application,
  sessionId: SessionID,
  params?: Params
): Promise<Task[]> {
  return findTasksForSession(app, sessionId, params, EXECUTING_TASK_STATUSES);
}

/**
 * The single most-recent active task — preferred when callers want "the
 * task that is driving this session right now." Falls back to the most-
 * recent task of any status when nothing is active, so widget messages /
 * system messages always land somewhere visible to the transcript renderer.
 *
 * Returns `undefined` when the session has no tasks at all (brand-new
 * session).
 */
export async function findHostTaskForSession(
  app: Application,
  sessionId: SessionID,
  params?: Params
): Promise<Task | undefined> {
  const all = await findTasksForSession(app, sessionId, params);
  if (all.length === 0) return undefined;
  return all.find((t) => isTaskExecuting(t)) ?? all[0];
}
