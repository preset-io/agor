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

/**
 * Cap on the number of recent task IDs we remember for dedupe. Sized to
 * comfortably cover any realistic burst of completions a single user could
 * trigger before the LRU starts evicting. Re-exported only for tests.
 */
export const MAX_CHIMED_HISTORY = 500;

export function useTaskCompletionChime(
  client: AgorClient | null,
  currentUserId: string | undefined,
  audioPreferences: AudioPreferences | undefined
): void {
  // Bounded by concurrent in-flight tasks — entries are evicted on transition.
  const runningTaskIdsRef = useRef<Set<string>>(new Set());

  // Persistent per-task dedupe. The ref intentionally survives subscription
  // teardown/reconnect so duplicate terminal events cannot replay the chime.
  // Bounded by MAX_CHIMED_HISTORY to avoid lifetime growth; LRU touch on a
  // duplicate hit keeps frequently-referenced tasks from being evicted while
  // unrelated traffic floods in.
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

    // Chime is a personal notification — filter to the prompting user's own
    // tasks. Multiplayer clients receive events for any task they can see.
    const isOwnTask = (task: Task) => task?.created_by === currentUserId;

    const markChimed = (taskId: string) => {
      chimed.add(taskId);
      if (chimed.size > MAX_CHIMED_HISTORY) {
        // Set iteration order is insertion order — first entry is oldest.
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

      // LRU touch: re-insert refreshes recency so a noisy task can't get
      // evicted from the dedupe window while it keeps emitting events.
      if (chimed.delete(task.task_id)) {
        chimed.add(task.task_id);
        return;
      }
      markChimed(task.task_id);

      void playTaskCompletionChime(task, audioPrefsRef.current);
    };

    const handleTaskRemoved = (task: Task) => {
      // Only clear the running entry. We deliberately do NOT drop the chimed
      // entry: task_ids are UUIDv7 and never reused, so the slot can't
      // collide, and keeping it pins the "one chime per task" guarantee
      // even if a delayed RUNNING/terminal replay arrives after delete.
      if (task?.task_id) running.delete(task.task_id);
    };

    tasksService.on('created', handleTaskChange);
    tasksService.on('patched', handleTaskChange);
    tasksService.on('updated', handleTaskChange);
    tasksService.on('removed', handleTaskRemoved);

    // Seed running tasks already in flight at mount (page reload, reconnect).
    // Subscribe-first-then-fetch: any transition landing during the fetch is
    // still handled by the live handler; at worst we add a stale ID for a
    // task that has already finished, which never triggers a chime.
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
      // chimedTaskIds intentionally persists across teardowns — see ref decl.
    };
  }, [client, currentUserId]);
}
