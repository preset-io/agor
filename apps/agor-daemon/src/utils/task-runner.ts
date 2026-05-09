/**
 * Helpers for triggering execution of an already-created Task.
 *
 * Used by `POST /tasks/:id/run` (the pure-REST executor trigger added for
 * issue #1118). Sits one level above `spawnTaskExecutor` — the canonical
 * "transition queued/created → running and fork the executor" primitive in
 * `register-routes.ts` — and adds:
 *
 *   - **Race-safe claim**: an in-memory per-task lock rejects concurrent
 *     runs of the same task ID with `Conflict`. Without this, two
 *     simultaneous `POST /tasks/:id/run` calls would both observe `created`
 *     status, both call `spawnTaskExecutor`, and both fork an executor —
 *     producing a duplicate user-message row and two parallel executor
 *     processes for the same task.
 *
 *   - **Mid-flight status revalidation**: re-reads the task inside the
 *     lock to defend against patches landing between the route's initial
 *     status check and the spawn handoff.
 *
 * Single-process only — multi-instance deployments would additionally need
 * a row-level DB lock or an atomic conditional UPDATE. The queue processor
 * uses the same in-memory pattern at the session level
 * (`queueProcessingLocks` in `register-routes.ts`).
 */
import { Conflict, NotFound } from '@agor/core/feathers';
import type { MessageSource, Params, PermissionMode, Task, TaskID } from '@agor/core/types';
import { TaskStatus } from '@agor/core/types';

export interface ClaimAndRunOptions {
  permissionMode?: PermissionMode;
  stream?: boolean;
  messageSource?: MessageSource;
}

export type SpawnTaskExecutorFn = (
  task: Task,
  options: ClaimAndRunOptions,
  params: Params
) => Promise<Task>;

export interface ClaimAndRunDeps {
  /** Used to re-fetch the task inside the lock for status revalidation. */
  findTaskById: (id: string) => Promise<Task | null>;
  /** The canonical spawn helper — `spawnTaskExecutor` from register-routes.ts. */
  spawnFn: SpawnTaskExecutorFn;
  /** Per-task lock map, shared across calls within the same process. */
  locks: Map<TaskID, Promise<void>>;
}

/**
 * Atomically claim a `created` task and hand off to the spawn function.
 *
 * Throws:
 *   - `Conflict` if another caller is already starting this task.
 *   - `NotFound` if the task disappeared between the route's lookup and
 *     this call (e.g. an admin removed it).
 *   - `Conflict` if the task's status changed away from `created` mid-claim
 *     (e.g. the queue processor drained a queued sibling and patched this
 *     one in some unexpected way — defensive guard).
 */
export async function claimAndRunExistingTask(
  task: Task,
  options: ClaimAndRunOptions,
  params: Params,
  deps: ClaimAndRunDeps
): Promise<Task> {
  if (deps.locks.has(task.task_id)) {
    throw new Conflict(
      `Task ${task.task_id.substring(0, 8)} is already being started by a concurrent request.`
    );
  }

  let resolveLock!: () => void;
  const lockPromise = new Promise<void>((r) => {
    resolveLock = r;
  });
  deps.locks.set(task.task_id, lockPromise);

  try {
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
  } finally {
    deps.locks.delete(task.task_id);
    resolveLock();
  }
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
