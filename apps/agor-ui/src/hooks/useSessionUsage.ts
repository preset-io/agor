import type { AgorClient, Session } from '@agor-live/client';
import { useEffect, useState } from 'react';
import { TOKENS_REFRESHED_EVENT } from '../utils/singleFlightRefresh';

/** A fresh accounting snapshot per disclosure opening, never per task/tool event. */
export function useSessionUsage(
  client: AgorClient | null,
  sessionId: string,
  enabled: boolean,
  userId?: string
) {
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<{
    client: AgorClient;
    id: string;
    userId?: string;
    revision: number;
    usage?: Session['usage_summary'];
    error?: string;
  } | null>(null);
  useEffect(() => {
    if (!enabled || !client) {
      setResult(null);
      return;
    }
    let disposed = false;
    const credentialsChanged = () => {
      disposed = true;
      setResult(null);
      setRevision((value) => value + 1);
    };
    window.addEventListener(TOKENS_REFRESHED_EVENT, credentialsChanged);
    void client
      .service('sessions')
      .get(sessionId, { query: { include_usage: true } })
      .then((session) => {
        if (!disposed)
          setResult({
            client,
            id: sessionId,
            userId,
            revision,
            usage: session.usage_summary,
            error: session.usage_summary ? undefined : 'Usage is unavailable.',
          });
      })
      .catch(() => {
        if (!disposed)
          setResult({ client, id: sessionId, userId, revision, error: 'Could not load usage.' });
      });
    return () => {
      disposed = true;
      window.removeEventListener(TOKENS_REFRESHED_EVENT, credentialsChanged);
    };
  }, [client, sessionId, enabled, userId, revision]);
  const current =
    enabled &&
    result?.client === client &&
    result?.id === sessionId &&
    result?.userId === userId &&
    result?.revision === revision
      ? result
      : null;
  return {
    usage: current?.usage,
    error: current?.error,
    loading: enabled && !!client && !current,
    retry: () => setRevision((value) => value + 1),
  };
}
