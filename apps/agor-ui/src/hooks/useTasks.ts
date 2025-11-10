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
 * @returns Tasks array, loading state, error, and refetch function
 */
export function useTasks(
  client: AgorClient | null,
  sessionId: SessionID | null,
  user: User | null = null
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
  }, [client, sessionId]);

  // Subscribe to real-time task updates
  useEffect(() => {
    if (!client || !sessionId) return;

    // Initial fetch
    fetchTasks();

    // Subscribe to task events for this session
    const tasksService = client.service('tasks');

    const handleTaskCreated = (task: Task) => {
      // Only add if it belongs to this session
      if (task.session_id === sessionId) {
        setTasks(prev => {
          // Check if task already exists (avoid duplicates)
          if (prev.some(t => t.task_id === task.task_id)) {
            return prev;
          }
          // Insert in correct position based on created_at
          const newTasks = [...prev, task];
          return newTasks.sort(
            (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
          );
        });
      }
    };

    const handleTaskPatched = (task: Task) => {
      if (task.session_id === sessionId) {
        setTasks(prev => {
          // Find the previous task state to detect transitions
          const oldTask = prev.find(t => t.task_id === task.task_id);
          const wasRunning = oldTask?.status === TaskStatus.RUNNING;
          const isNowDone =
            task.status === TaskStatus.COMPLETED || task.status === TaskStatus.FAILED;

          // Play chime if transitioning from RUNNING to COMPLETED/FAILED
          if (wasRunning && isNowDone) {
            playTaskCompletionChime(task, user?.preferences?.audio);
          }

          return prev.map(t => (t.task_id === task.task_id ? task : t));
        });
      }
    };

    const handleTaskRemoved = (task: Task) => {
      if (task.session_id === sessionId) {
        setTasks(prev => prev.filter(t => t.task_id !== task.task_id));
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
  }, [client, sessionId, fetchTasks, user]);

  return {
    tasks,
    loading,
    error,
    refetch: fetchTasks,
  };
}
