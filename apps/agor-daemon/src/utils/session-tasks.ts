/**
 * Helpers for finding "active" tasks for a session — DISPATCHING / RUNNING / STOPPING /
 * AWAITING_PERMISSION / AWAITING_INPUT — sorted by recency.
 *
 * Keep the active-task selection rule centralized for widget, stop, and
 * system-message callers. Do not hydrate a capped historical Session page:
 * long-running Sessions can have thousands of completed Tasks while the one
 * executor-owned Task is newer than the cap. Instead issue one LIMIT 1 SQL
 * query per executing status and choose the newest candidate. The fallback is
 * another targeted LIMIT 1 query over the exact Session.
 */

import type { Application } from '@agor/core/feathers';
import type { Paginated, Params, SessionID, Task } from '@agor/core/types';
import { EXECUTING_TASK_STATUSES } from '@agor/core/types';

function recencyKey(t: Task): number {
  return new Date(t.started_at || t.created_at).getTime();
}

async function findMostRecentTaskForSession(
  app: Application,
  sessionId: SessionID,
  status: Task['status'] | undefined,
  params?: Params
): Promise<Task | undefined> {
  const result = (await app.service('tasks').find({
    ...(params ?? {}),
    query: {
      session_id: sessionId,
      ...(status ? { status } : {}),
      $sort: { created_at: -1, task_id: -1 },
      $limit: 1,
      $skip: 0,
    },
  })) as Paginated<Task> | Task[];
  const tasks = Array.isArray(result) ? result : result.data;
  return tasks[0];
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
  const candidates = await Promise.all(
    [...EXECUTING_TASK_STATUSES].map((status) =>
      findMostRecentTaskForSession(app, sessionId, status, params)
    )
  );
  return candidates
    .filter((task): task is Task => task !== undefined)
    .sort((a, b) => recencyKey(b) - recencyKey(a) || b.task_id.localeCompare(a.task_id));
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
  const active = await findActiveTasksForSession(app, sessionId, params);
  return active[0] ?? findMostRecentTaskForSession(app, sessionId, undefined, params);
}
