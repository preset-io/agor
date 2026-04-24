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
import { playTaskCompletionChime } from '../utils/audio';
import type { FeathersEventHandler } from './index';

export function useTaskCompletionChime(
  client: AgorClient | null,
  user: User | null | undefined
): void {
  // Track last known status per task so we fire the chime exactly once on
  // RUNNING → COMPLETED/FAILED transitions (patched events can fan out).
  const lastStatusRef = useRef<Map<string, Task['status']>>(new Map());

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

      const prev = lastStatusRef.current.get(task.task_id);
      lastStatusRef.current.set(task.task_id, task.status);

      const wasRunning = prev === TaskStatus.RUNNING;
      const isNowDone = task.status === TaskStatus.COMPLETED || task.status === TaskStatus.FAILED;

      if (wasRunning && isNowDone) {
        void playTaskCompletionChime(task, audioPrefsRef.current);
      }
    };

    const handleTaskRemoved = (task: Task) => {
      if (task?.task_id) {
        lastStatusRef.current.delete(task.task_id);
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
      lastStatusRef.current.clear();
    };
  }, [client]);
}
