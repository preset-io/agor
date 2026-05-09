/**
 * Helpers for triggering execution of an already-created Task.
 *
 * Used by `POST /tasks/:id/run` (the pure-REST executor trigger added for
 * issue #1118). Sits one level above `spawnTaskExecutor` — the canonical
 * "transition created/queued → running and fork the executor" primitive in
 * `register-routes.ts` — and adds a status revalidation step to defend
 * against patches landing between the route's initial check and the spawn
 * handoff.
 *
 * Mutual exclusion across concurrent callers is handled by
 * `withSessionTurnLock` (see `session-turn-lock.ts`), wrapped around this
 * call by the route handler. Keeping the lock concern in the route lets the
 * same session-level lock cover both `/tasks/:id/run` and
 * `/sessions/:id/prompt`, closing the cross-route race that a per-task
 * lock would miss.
 */
import { Conflict, NotFound } from '@agor/core/feathers';
import type { MessageSource, Params, PermissionMode, Task } from '@agor/core/types';
import { TaskStatus } from '@agor/core/types';

export interface RunExistingTaskOptions {
  permissionMode?: PermissionMode;
  stream?: boolean;
  messageSource?: MessageSource;
}

export type SpawnTaskExecutorFn = (
  task: Task,
  options: RunExistingTaskOptions,
  params: Params
) => Promise<Task>;

export interface RunExistingTaskDeps {
  /** Used to re-fetch the task for status revalidation. */
  findTaskById: (id: string) => Promise<Task | null>;
  /** The canonical spawn helper — `spawnTaskExecutor` from register-routes.ts. */
  spawnFn: SpawnTaskExecutorFn;
}

/**
 * Re-fetch a task, verify it's still in `created` state, and hand off to
 * the spawn function. Caller is responsible for any session-level locking
 * (see `withSessionTurnLock`) — this helper only concerns itself with task
 * state.
 *
 * Throws:
 *   - `NotFound` if the task disappeared between the route's lookup and
 *     this call (e.g. an admin removed it).
 *   - `Conflict` if the task's status changed away from `created` mid-claim
 *     (e.g. another caller started it via the same route, or the queue
 *     processor reassigned it).
 */
export async function runExistingTask(
  task: Task,
  options: RunExistingTaskOptions,
  params: Params,
  deps: RunExistingTaskDeps
): Promise<Task> {
  const fresh = await deps.findTaskById(task.task_id);
  if (!fresh) {
    throw new NotFound(`Task ${task.task_id} no longer exists`);
  }
  if (fresh.status !== TaskStatus.CREATED) {
    throw new Conflict(
      `Task ${task.task_id.substring(0, 8)} cannot be run: status is '${fresh.status}' ` +
        `(only 'created' tasks may be triggered; the task may have been started by ` +
        `another caller or drained from the queue).`
    );
  }

  return await deps.spawnFn(fresh, options, params);
}

/**
 * Normalize a caller-supplied `messageSource` field. Mirrors the gate used
 * by `/sessions/:id/prompt` so the two routes behave identically: invalid
 * values fall back to `'agor'` for socket/REST callers and `undefined` for
 * internal calls.
 */
export function normalizeMessageSource(
  input: MessageSource | undefined,
  params: Params
): MessageSource | undefined {
  if (input !== undefined && input !== 'gateway' && input !== 'agor') {
    return params.provider ? 'agor' : undefined;
  }
  return input;
}
