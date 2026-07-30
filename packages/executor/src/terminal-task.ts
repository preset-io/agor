/**
 * Terminal-status helpers for the executor's fail-safe paths.
 *
 * The executor has four fail-safe paths that try to mark a task terminal —
 * the top-level catch in `AgorExecutor.start()`, the SIGTERM/SIGINT
 * shutdown handler, the `uncaughtException` handler, and the
 * `unhandledRejection` handler. Legacy SDK handlers still write their normal
 * terminal payloads. Runtime adapters that return completion facts are
 * finalized here only after their cleanup has settled. In either case,
 * fail-safe paths must NOT redundantly emit a second `'patched'` event —
 * that's the bug the UI saw as "chime plays twice".
 *
 * Lives outside `index.ts` so the helper and its constant don't pollute
 * the package's public surface, and so the unit tests don't have to
 * import from the file that bootstraps the executor.
 */
import { shortId } from '@agor/core/db';
import type { Task } from '@agor/core/types';
import { TaskStatus } from '@agor/core/types';
import type { AgorClient } from './services/feathers-client.js';

export async function completeTaskAfterRuntimeCleanup(
  client: AgorClient,
  taskId: string,
  data: { model?: string }
): Promise<void> {
  await client.service('tasks').complete(taskId, data);
}

/**
 * Statuses past which any subsequent terminal-write is a no-op.
 * Includes `TIMED_OUT` so a subsequent uncaught-rejection/SIGTERM
 * doesn't overwrite a permission/input timeout with `FAILED` or
 * `STOPPED`.
 */
export const TERMINAL_STATUSES: ReadonlySet<Task['status']> = new Set<Task['status']>([
  TaskStatus.COMPLETED,
  TaskStatus.FAILED,
  TaskStatus.STOPPED,
  TaskStatus.TIMED_OUT,
]);

/**
 * Patch a task to a terminal status, but ONLY if the task is not already
 * terminal. Reads the task first and bails on terminal — the inner SDK
 * patch is authoritative; this is a fallback for cases where it never
 * ran (SDK init crash, etc.).
 */
export async function tryMarkTaskTerminal(
  client: AgorClient,
  taskId: string,
  status: typeof TaskStatus.FAILED | typeof TaskStatus.STOPPED,
  errorMessage?: string
): Promise<void> {
  try {
    const current = (await client.service('tasks').get(taskId)) as Task;
    if (TERMINAL_STATUSES.has(current.status)) {
      console.log(
        `[executor] Task ${shortId(taskId)} already terminal (${current.status}), skipping ${status} patch`
      );
      return;
    }
    await client.service('tasks').patch(taskId, {
      status,
      completed_at: new Date().toISOString(),
      ...(errorMessage ? { error_message: errorMessage } : {}),
    });
  } catch (patchError) {
    console.error('[executor] Failed to update task status:', patchError);
  }
}
