import type { AgorClient, Session, Task } from '@agor-live/client';
import { useEffect, useState } from 'react';
import { TOKENS_REFRESHED_EVENT } from '../utils/singleFlightRefresh';

/** Session-wide accounting has a different lifetime/membership than transcript pages. */
export function useSessionUsage(
  client: AgorClient | null,
  sessionId: string | null,
  enabled: boolean,
  userId?: string
) {
  const [result, setResult] = useState<{
    client: AgorClient;
    id: string;
    userId?: string;
    usage: Session['usage_summary'];
  } | null>(null);
  useEffect(() => {
    if (!client || !sessionId || !enabled) return;
    let disposed = false;
    let running = false;
    let dirty = false;
    const refresh = async () => {
      dirty = true;
      if (running) return;
      running = true;
      try {
        do {
          dirty = false;
          try {
            const session = await client
              .service('sessions')
              .get(sessionId, { query: { include_usage: true } });
            if (!disposed && !dirty)
              setResult({ client, id: sessionId, userId, usage: session.usage_summary });
          } catch {
            if (!disposed) setResult(null);
          }
        } while (dirty && !disposed);
      } finally {
        running = false;
      }
    };
    const onTask = (task: Task) => {
      if (task.session_id === sessionId) void refresh();
    };
    const onReconnect = () => {
      void refresh();
    };
    const onCredentialsChanged = () => {
      setResult(null);
      void refresh();
    };
    const tasks = client.service('tasks');
    for (const event of ['created', 'patched', 'updated', 'removed'] as const)
      tasks.on(event, onTask);
    client.io?.on('connect', onReconnect);
    window.addEventListener(TOKENS_REFRESHED_EVENT, onCredentialsChanged);
    void refresh();
    return () => {
      disposed = true;
      for (const event of ['created', 'patched', 'updated', 'removed'] as const)
        tasks.off(event, onTask);
      client.io?.off('connect', onReconnect);
      window.removeEventListener(TOKENS_REFRESHED_EVENT, onCredentialsChanged);
    };
  }, [client, sessionId, enabled, userId]);
  return enabled &&
    result?.client === client &&
    result?.id === sessionId &&
    result?.userId === userId
    ? result.usage
    : undefined;
}
