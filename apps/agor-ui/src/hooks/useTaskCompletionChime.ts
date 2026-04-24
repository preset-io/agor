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

export function useTaskCompletionChime(
  client: AgorClient | null,
  currentUserId: string | undefined,
  audioPreferences: AudioPreferences | undefined
): void {
  // Track task IDs currently in RUNNING state so we fire exactly once on the
  // RUNNING → terminal transition. Only RUNNING entries are kept, so the set
  // is bounded by concurrent in-flight tasks rather than lifetime tasks.
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

    // The chime is a personal notification for the prompting user. In a
    // multiplayer setup the tasks service streams events for any task the
    // viewer can see, so we filter by Task.created_by — "chime when my
    // prompts finish", not "chime when anyone's prompts finish".
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
      if (task?.task_id) {
        running.delete(task.task_id);
      }
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
    };
  }, [client, currentUserId]);
}
