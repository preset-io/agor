import type { AgorClient, Session, Task } from '@agor-live/client';
import { useEffect, useMemo, useState } from 'react';
import type { FeathersEventHandler } from '../../hooks';
import { chooseLatestBranchTask } from './latestBranchTask';

interface LatestBranchTaskResult {
  task: Task | null;
  session: Session | null;
  loading: boolean;
  error: string | null;
}

export function useLatestBranchTask(
  client: AgorClient | null,
  sessions: Session[],
  enabled: boolean
): LatestBranchTaskResult {
  const activeSessions = useMemo(() => sessions.filter((session) => !session.archived), [sessions]);
  const sessionById = useMemo(
    () => new Map(activeSessions.map((session) => [session.session_id, session])),
    [activeSessions]
  );
  const sessionIdsKey = useMemo(
    () =>
      activeSessions
        .map((session) => session.session_id)
        .sort()
        .join('|'),
    [activeSessions]
  );

  const [tasksBySession, setTasksBySession] = useState<Map<string, Task[]>>(new Map());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const activeSessionIds = sessionIdsKey ? sessionIdsKey.split('|') : [];

    if (!enabled || !client || activeSessionIds.length === 0) {
      setTasksBySession(new Map());
      setLoading(false);
      setError(null);
      return;
    }

    let disposed = false;
    const sessionIds = new Set(activeSessionIds);

    const fetchTasks = async () => {
      setLoading(true);
      setError(null);
      try {
        const entries = await Promise.all(
          activeSessionIds.map(async (sessionId) => {
            const tasks = await client.service('tasks').findAll({
              query: { session_id: sessionId },
            });
            return [sessionId, tasks] as const;
          })
        );

        if (!disposed) {
          setTasksBySession(new Map(entries));
        }
      } catch (err) {
        if (!disposed) {
          setError(err instanceof Error ? err.message : 'Failed to load branch tasks');
        }
      } finally {
        if (!disposed) setLoading(false);
      }
    };

    void fetchTasks();

    const tasksService = client.service('tasks');

    const upsertTask = (task: Task) => {
      if (!sessionIds.has(task.session_id)) return;
      setTasksBySession((prev) => {
        const next = new Map(prev);
        const current = next.get(task.session_id) || [];
        const index = current.findIndex((item) => item.task_id === task.task_id);
        const nextTasks = index === -1 ? [...current, task] : [...current];
        if (index !== -1) nextTasks[index] = task;
        nextTasks.sort((a, b) => a.created_at.localeCompare(b.created_at));
        next.set(task.session_id, nextTasks);
        return next;
      });
    };

    const removeTask = (task: Task) => {
      if (!sessionIds.has(task.session_id)) return;
      setTasksBySession((prev) => {
        const current = prev.get(task.session_id);
        if (!current) return prev;
        const next = new Map(prev);
        next.set(
          task.session_id,
          current.filter((item) => item.task_id !== task.task_id)
        );
        return next;
      });
    };

    tasksService.on('created', upsertTask);
    tasksService.on('queued', upsertTask as FeathersEventHandler);
    tasksService.on('patched', upsertTask);
    tasksService.on('updated', upsertTask);
    tasksService.on('removed', removeTask);

    return () => {
      disposed = true;
      tasksService.removeListener('created', upsertTask);
      tasksService.removeListener('queued', upsertTask as FeathersEventHandler);
      tasksService.removeListener('patched', upsertTask);
      tasksService.removeListener('updated', upsertTask);
      tasksService.removeListener('removed', removeTask);
    };
  }, [client, enabled, sessionIdsKey]);

  return useMemo(() => {
    const { task, session } = chooseLatestBranchTask(tasksBySession, sessionById);

    return {
      task,
      session,
      loading,
      error,
    };
  }, [error, loading, sessionById, tasksBySession]);
}
