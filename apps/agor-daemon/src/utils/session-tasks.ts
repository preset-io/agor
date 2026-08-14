/**
 * Helpers for finding "active" tasks for a session — DISPATCHING / RUNNING / STOPPING /
 * AWAITING_PERMISSION / AWAITING_INPUT — sorted by recency.
 *
 * Keep the active-task selection rule centralized for widget, stop, and
 * system-message callers. TasksService now composes Session/status filters in
 * SQL, but these callers intentionally need both the active subset and a
 * most-recent fallback from one complete Session snapshot.
 */

import type { Application } from '@agor/core/feathers';
import type { Paginated, Params, SessionID, Task } from '@agor/core/types';
import { isTaskExecuting } from '@agor/core/types';

function recencyKey(t: Task): number {
  return new Date(t.started_at || t.created_at).getTime();
}

/**
 * All tasks for the session, returned in recency-DESC order (most recently
 * started/created first). Useful when callers want a fallback path.
 */
export async function findTasksForSession(
  app: Application,
  sessionId: SessionID,
  params?: Params
): Promise<Task[]> {
  const result = (await app.service('tasks').find({
    ...(params ?? {}),
    // Merge defensively: spread params first, then force session_id so a
    // caller-supplied params.query can never silently overwrite the filter.
    query: {
      ...(params?.query as Record<string, unknown> | undefined),
      session_id: sessionId,
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
  const all = await findTasksForSession(app, sessionId, params);
  return all.filter((t) => isTaskExecuting(t));
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
