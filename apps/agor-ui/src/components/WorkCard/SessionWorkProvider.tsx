import { type AgorClient, type Session, TaskStatus } from '@agor-live/client';
import { useMemo } from 'react';
import { assignWorkToTasks, useSessionWork } from '../../hooks/useSessionWork';
import { useSharedReactiveSession } from '../../hooks/useSharedReactiveSession';
import { SessionWorkContext, type SessionWorkValue } from './WorkCard';

/**
 * Reads a conversation's work and places each card after its turn, so
 * `TaskBlock` renders them without new props. Shares the transcript's reactive
 * session; the value changes only when the work or the list of turns does.
 */
export const SessionWorkProvider: React.FC<{
  client: AgorClient | null;
  session: Session;
  boardId?: string | null;
  branchId?: string;
  /** The conversation is on screen. */
  active: boolean;
  children: React.ReactNode;
}> = ({ client, session, boardId, branchId, active, children }) => {
  const items = useSessionWork(client, session, boardId);
  const { state } = useSharedReactiveSession(client, session.session_id, {
    enabled: active,
    reactiveOptions: { taskHydration: 'lean' },
  });
  const current = state?.sessionId === session.session_id ? state : null;
  // Turns as a string, so streaming patches that change nothing here keep the value.
  const turns = (current?.tasks ?? [])
    .filter((task) => task.status !== TaskStatus.QUEUED)
    .map((task) => `${task.task_id}@${task.created_at}`)
    .join('|');
  const hasOlderTasks = !!current?.hasOlderTasks;

  const value = useMemo<SessionWorkValue>(() => {
    const tasks = turns
      ? turns.split('|').map((entry) => {
          const [task_id, created_at] = entry.split('@');
          return { task_id, created_at };
        })
      : [];
    return {
      sessionId: session.session_id,
      byTask: assignWorkToTasks(items, tasks, { hasOlderTasks }),
      latestTaskId: tasks.at(-1)?.task_id,
      branchId,
    };
  }, [items, turns, hasOlderTasks, session.session_id, branchId]);

  return <SessionWorkContext.Provider value={value}>{children}</SessionWorkContext.Provider>;
};
