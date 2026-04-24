/**
 * Subscribes globally to `tasks` service events and plays the user's
 * configured chime when a task transitions from RUNNING → COMPLETED/FAILED.
 *
 * This is intentionally global (mounted once at the App level) rather than
 * per-session: the whole point of the chime is that the user is *off doing
 * something else*, so the chime must fire even when the session panel isn't
 * mounted.
 */

import type { AgorClient, Task, User } from '@agor-live/client';
import { TaskStatus } from '@agor-live/client';
import { useEffect, useRef } from 'react';
import { isNaturalCompletion, playTaskCompletionChime } from '../utils/audio';
import type { FeathersEventHandler } from './index';

export function useTaskCompletionChime(
  client: AgorClient | null,
  user: User | null | undefined
): void {
  // Track task IDs currently in RUNNING state so we fire exactly once on the
  // RUNNING → terminal transition. Only RUNNING entries are kept, so the set
  // is bounded by concurrent in-flight tasks rather than lifetime tasks.
  const runningTaskIdsRef = useRef<Set<string>>(new Set());

  // Keep audio prefs in a ref so the subscription effect doesn't tear down on
  // every preference change (e.g. while the user is tweaking the slider).
  const audioPrefsRef = useRef(user?.preferences?.audio);
  useEffect(() => {
    audioPrefsRef.current = user?.preferences?.audio;
  }, [user?.preferences?.audio]);

  useEffect(() => {
    if (!client) return;

    const tasksService = client.service('tasks');

    const handleTaskChange = (task: Task) => {
      if (!task?.task_id) return;
      const running = runningTaskIdsRef.current;

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
        runningTaskIdsRef.current.delete(task.task_id);
      }
    };

    tasksService.on('created', handleTaskChange as FeathersEventHandler);
    tasksService.on('patched', handleTaskChange as FeathersEventHandler);
    tasksService.on('updated', handleTaskChange as FeathersEventHandler);
    tasksService.on('removed', handleTaskRemoved as FeathersEventHandler);

    return () => {
      tasksService.removeListener('created', handleTaskChange as FeathersEventHandler);
      tasksService.removeListener('patched', handleTaskChange as FeathersEventHandler);
      tasksService.removeListener('updated', handleTaskChange as FeathersEventHandler);
      tasksService.removeListener('removed', handleTaskRemoved as FeathersEventHandler);
      runningTaskIdsRef.current.clear();
    };
  }, [client]);
}
