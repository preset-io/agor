/**
 * Subscribes globally to `tasks` service events and plays the user's
 * configured chime when a task transitions from RUNNING → COMPLETED/FAILED.
 *
 * This is intentionally global (mounted once at the App level) rather than
 * per-session: the whole point of the chime is that the user is *off doing
 * something else*, so the chime must fire even when the session panel isn't
 * mounted.
 *
 * Dedupe model: a Set of currently-RUNNING task IDs. Each terminal event
 * tries to `delete()` the entry; the first one returns true and fires the
 * chime, every subsequent terminal event for the same task returns false
 * (entry already gone) and is a no-op. This handles the normal-path
 * duplicate emits — the daemon's executor-double-catch path (also fixed
 * at the source in `packages/executor/src/terminal-task.ts`), the
 * stateless_fs_mode post-completion `session_md5` patch, and similar
 * tail emits.
 *
 * Known edge case we explicitly accept: if the seed `findAll` resolves
 * after a live terminal event for the same task, the seed re-adds the
 * task to the running set, and a subsequent tail emit could re-arm the
 * chime. This requires a specific inter-event/RPC ordering that's
 * vanishingly rare in practice; the chime is a low-stakes notification
 * and we'd rather keep the hook small than guard against it.
 */

import type { AgorClient, AudioPreferences, Task } from '@agor-live/client';
import { isNaturalCompletion, TaskStatus } from '@agor-live/client';
import { useEffect, useRef } from 'react';
import { playTaskCompletionChime } from '../utils/audio';

export function useTaskCompletionChime(
  client: AgorClient | null,
  currentUserId: string | undefined,
  audioPreferences: AudioPreferences | undefined
): void {
  // Bounded by concurrent in-flight tasks — entries are evicted on transition.
  const runningTaskIdsRef = useRef<Set<string>>(new Set());

  // Keep audio prefs in a ref so the subscription effect doesn't tear down on
  // every preference change (e.g. while the user is tweaking the slider).
  const audioPrefsRef = useRef(audioPreferences);
  useEffect(() => {
    audioPrefsRef.current = audioPreferences;
  }, [audioPreferences]);

  useEffect(() => {
    if (!client || !currentUserId) return;

    const tasksService = client.service('tasks');
    const running = runningTaskIdsRef.current;
    let disposed = false;

    // Chime is a personal notification — filter to the prompting user's own
    // tasks. Multiplayer clients receive events for any task they can see.
    const isOwnTask = (task: Task) => task?.created_by === currentUserId;

    const handleTaskChange = (task: Task) => {
      if (!task?.task_id || !isOwnTask(task)) return;

      if (task.status === TaskStatus.RUNNING) {
        running.add(task.task_id);
        return;
      }

      const wasRunning = running.delete(task.task_id);
      if (wasRunning && isNaturalCompletion(task.status)) {
        void playTaskCompletionChime(task, audioPrefsRef.current);
      }
    };

    const handleTaskRemoved = (task: Task) => {
      if (task?.task_id) running.delete(task.task_id);
    };

    tasksService.on('created', handleTaskChange);
    tasksService.on('patched', handleTaskChange);
    tasksService.on('updated', handleTaskChange);
    tasksService.on('removed', handleTaskRemoved);

    // Seed running tasks already in flight at mount (page reload, reconnect).
    // Subscribe-first-then-fetch: live events during the fetch are still
    // handled by the live handler. See the file header for the accepted
    // seed-vs-live ordering edge case.
    tasksService
      .findAll({ query: { status: TaskStatus.RUNNING, created_by: currentUserId } })
      .then((tasks: Task[]) => {
        if (disposed) return;
        for (const task of tasks) {
          if (task?.task_id) running.add(task.task_id);
        }
      })
      .catch(() => {
        // Non-fatal: live events still work. Worst case we miss chimes for
        // tasks already running before mount.
      });

    return () => {
      disposed = true;
      tasksService.removeListener('created', handleTaskChange);
      tasksService.removeListener('patched', handleTaskChange);
      tasksService.removeListener('updated', handleTaskChange);
      tasksService.removeListener('removed', handleTaskRemoved);
      running.clear();
    };
  }, [client, currentUserId]);
}
