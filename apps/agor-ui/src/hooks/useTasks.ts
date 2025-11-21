/**
 * React hook for fetching and subscribing to tasks for a session
 */

import type { AgorClient } from '@agor/core/api';
import { type SessionID, type Task, TaskStatus, type User } from '@agor/core/types';
import { useCallback, useEffect, useState } from 'react';
import { playTaskCompletionChime } from '../utils/audio';

interface UseTasksResult {
  tasks: Task[];
  loading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
}

/**
 * Fetch and subscribe to tasks for a specific session
 *
 * @param client - Agor client instance
 * @param sessionId - Session ID to fetch tasks for
 * @param user - Current user (for audio preferences)
 * @param enabled - When false, skip fetching/subscribing (cached tasks remain)
 * @returns Tasks array, loading state, error, and refetch function
 */
export function useTasks(
  client: AgorClient | null,
  sessionId: SessionID | null,
  user: User | null = null,
  enabled = true
): UseTasksResult {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch tasks for session
  const fetchTasks = useCallback(async () => {
    if (!client || !sessionId) {
      setTasks([]);
      return;
    }

    if (!enabled) {
      return;
    }

    try {
      setLoading(true);
      setError(null);

      const result = await client.service('tasks').find({
        query: {
          session_id: sessionId,
          $limit: 1000, // Fetch up to 1000 tasks
          $sort: {
            created_at: 1, // Sort by creation time ascending
          },
        },
      });

      const tasksList = Array.isArray(result) ? result : result.data;
      setTasks(tasksList);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch tasks');
    } finally {
      setLoading(false);
    }
  }, [client, sessionId, enabled]);

  // Subscribe to real-time task updates
  useEffect(() => {
    if (!client || !sessionId || !enabled) return;

    // Initial fetch
    fetchTasks();

    // Subscribe to task events for this session
    const tasksService = client.service('tasks');

    const handleTaskCreated = (task: Task) => {
      // Only add if it belongs to this session
      if (task.session_id === sessionId) {
        setTasks((prev) => {
          // Check if task already exists (avoid duplicates)
          if (prev.some((t) => t.task_id === task.task_id)) {
            return prev;
          }
          // Tasks are created chronologically, so new tasks always go at the end
          // No need to re-sort - DB already sorted initial load by created_at ascending
          return [...prev, task];
        });
      }
    };

    const handleTaskPatched = (task: Task) => {
      if (task.session_id === sessionId) {
        setTasks((prev) => {
          // Find index and previous task state
          const index = prev.findIndex((t) => t.task_id === task.task_id);

          // Task not found - shouldn't happen but handle gracefully
          if (index === -1) return prev;

          const oldTask = prev[index];

          // Check if task actually changed (reference equality)
          if (oldTask === task) return prev;

          const wasRunning = oldTask?.status === TaskStatus.RUNNING;
          const isNowDone =
            task.status === TaskStatus.COMPLETED || task.status === TaskStatus.FAILED;

          // Play chime if transitioning from RUNNING to COMPLETED/FAILED
          if (wasRunning && isNowDone) {
            playTaskCompletionChime(task, user?.preferences?.audio);
          }

          // Create new array with updated task at same position
          const newTasks = [...prev];
          newTasks[index] = task;
          return newTasks;
        });
      }
    };

    const handleTaskRemoved = (task: Task) => {
      if (task.session_id === sessionId) {
        setTasks((prev) => prev.filter((t) => t.task_id !== task.task_id));
      }
    };

    tasksService.on('created', handleTaskCreated);
    tasksService.on('patched', handleTaskPatched);
    tasksService.on('updated', handleTaskPatched);
    tasksService.on('removed', handleTaskRemoved);

    // Cleanup listeners
    return () => {
      tasksService.removeListener('created', handleTaskCreated);
      tasksService.removeListener('patched', handleTaskPatched);
      tasksService.removeListener('updated', handleTaskPatched);
      tasksService.removeListener('removed', handleTaskRemoved);
    };
  }, [client, sessionId, fetchTasks, user, enabled]);

  return {
    tasks,
    loading,
    error,
    refetch: fetchTasks,
  };
}
