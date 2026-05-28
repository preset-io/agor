/**
 * Subscribes globally to `tasks` service events and plays the user's
 * configured chime when a task transitions from RUNNING → COMPLETED/FAILED.
 *
 * This is intentionally global (mounted once at the App level) rather than
 * per-session: the whole point of the chime is that the user is *off doing
 * something else*, so the chime must fire even when the session panel isn't
 * mounted.
 */

import type { AgorClient, AudioPreferences, Task } from '@agor-live/client';
import { isNaturalCompletion, TaskStatus } from '@agor-live/client';
import { useEffect, useRef } from 'react';
import { playTaskCompletionChime } from '../utils/audio';
import type { FeathersEventHandler } from './index';

/**
 * Cap on the number of recently-chimed task IDs we remember.
 * Sized to comfortably cover any realistic burst of completions a single
 * user could trigger before the LRU starts evicting. Once an ID is
 * evicted the chime *could* re-fire for that task, but only if the
 * daemon emits another terminal event for the same `task_id`, which
 * is itself rare.
 *
 * Exported for tests.
 */
export const MAX_CHIMED_HISTORY = 500;

export function useTaskCompletionChime(
  client: AgorClient | null,
  currentUserId: string | undefined,
  audioPreferences: AudioPreferences | undefined
): void {
  // Track task IDs currently in RUNNING state so we fire on the
  // RUNNING → terminal transition only for tasks we observed start. Only
  // RUNNING entries are kept, so the set is bounded by concurrent in-flight
  // tasks rather than lifetime tasks.
  const runningTaskIdsRef = useRef<Set<string>>(new Set());

  // Per-task "already chimed" dedupe. Kept in a ref so it survives:
  //   - the effect tearing down + re-running (token rotation, currentUserId
  //     flipping between undefined and defined on auth load),
  //   - WebSocket reconnect replays,
  //   - the daemon emitting multiple `'patched'` events for the same
  //     completion (e.g. an executor-side patch to `COMPLETED` followed by
  //     a post-completion `session_md5` patch in stateless_fs_mode, or the
  //     base-executor + index.ts double-catch on failure both patching
  //     to `FAILED`),
  //   - any other source of duplicate terminal events for the same task_id.
  //
  // The previous implementation relied solely on `runningTaskIds.delete()`
  // returning true exactly once; that breaks if the running-set is cleared
  // out between two terminal events (effect teardown, status flicker), or
  // if the task is re-added before the second event arrives. This Set is
  // the final gate that guarantees "one chime per task completion".
  //
  // Insertion-ordered Set + size cap = simple LRU. We evict the oldest
  // entry rather than reset on a threshold so a long-running session can't
  // hit a momentary blind spot.
  const chimedTaskIdsRef = useRef<Set<string>>(new Set());

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
    const chimed = chimedTaskIdsRef.current;
    let disposed = false;

    // The chime is a personal notification for the prompting user. In a
    // multiplayer setup the tasks service streams events for any task the
    // viewer can see, so we filter by Task.created_by — "chime when my
    // prompts finish", not "chime when anyone's prompts finish".
    const isOwnTask = (task: Task) => task?.created_by === currentUserId;

    const markChimed = (taskId: string) => {
      chimed.add(taskId);
      if (chimed.size > MAX_CHIMED_HISTORY) {
        // Set iteration order is insertion order — `values().next().value`
        // is the oldest. Evict it so the set stays bounded.
        const oldest = chimed.values().next().value;
        if (oldest !== undefined) chimed.delete(oldest);
      }
    };

    const handleTaskChange = (task: Task) => {
      if (!task?.task_id || !isOwnTask(task)) return;

      if (task.status === TaskStatus.RUNNING) {
        running.add(task.task_id);
        return;
      }

      const wasRunning = running.delete(task.task_id);
      if (!wasRunning || !isNaturalCompletion(task.status)) return;

      // Final dedupe: don't re-play if we already chimed for this task,
      // even if the daemon emits more terminal events for it.
      if (chimed.has(task.task_id)) return;
      markChimed(task.task_id);

      void playTaskCompletionChime(task, audioPrefsRef.current);
    };

    const handleTaskRemoved = (task: Task) => {
      if (!task?.task_id) return;
      running.delete(task.task_id);
      // Drop the chimed entry too — once the task is gone the daemon can't
      // emit any more events for it, so the dedupe slot is free to reclaim.
      chimed.delete(task.task_id);
    };

    tasksService.on('created', handleTaskChange as FeathersEventHandler);
    tasksService.on('patched', handleTaskChange as FeathersEventHandler);
    tasksService.on('updated', handleTaskChange as FeathersEventHandler);
    tasksService.on('removed', handleTaskRemoved as FeathersEventHandler);

    // Seed the set with the current user's tasks that were already RUNNING
    // when the hook mounted (e.g. after a page reload or reconnect).
    // Without this, a subsequent transition to COMPLETED/FAILED would find
    // no prior membership and skip the chime. Subscribe-first-then-fetch
    // ordering means any transition that lands during the fetch is still
    // handled by the live handler; at worst we add a stale ID for a task
    // that has already finished, and the set gets one extra entry that
    // never triggers a chime.
    tasksService
      .findAll({ query: { status: TaskStatus.RUNNING, created_by: currentUserId } })
      .then((tasks: Task[]) => {
        if (disposed) return;
        for (const task of tasks) {
          if (task?.task_id) running.add(task.task_id);
        }
      })
      .catch(() => {
        // Non-fatal: if the initial fetch fails we just miss chimes for
        // tasks that were already running. Live events still work.
      });

    return () => {
      disposed = true;
      tasksService.removeListener('created', handleTaskChange as FeathersEventHandler);
      tasksService.removeListener('patched', handleTaskChange as FeathersEventHandler);
      tasksService.removeListener('updated', handleTaskChange as FeathersEventHandler);
      tasksService.removeListener('removed', handleTaskRemoved as FeathersEventHandler);
      running.clear();
      // NOTE: we intentionally do NOT clear `chimed` here. A token-refresh
      // or auth-flip teardown that wipes it would re-arm the chime for any
      // post-completion replay event landing on the new subscription.
    };
  }, [client, currentUserId]);
}
