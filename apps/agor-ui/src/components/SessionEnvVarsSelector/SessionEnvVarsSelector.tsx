/**
 * SessionEnvVarsSelector
 *
 * Multi-select of session-scope env vars belonging to the "owner user"
 * (the session's creator, or — at session-creation time — the current user).
 *
 * Lists only env vars whose scope is `session`. Global-scope vars are exported
 * automatically and not shown here. Reserved-for-v1 scopes are hidden.
 *
 * Controlled via `value` / `onChange`. Caller owns persistence:
 *   - Existing session → PATCH /sessions/:id/env-selections { envVarNames }
 *   - New session (pre-create) → store selection, POST after session is created.
 */

import type { AgorClient, EnvVarMetadata, User, UserID } from '@agor-live/client';
import { Alert, Select, Space, Typography } from 'antd';
import { useEffect, useMemo, useState } from 'react';

const { Text } = Typography;

export interface SessionEnvVarsSelectorProps {
  /** The user who owns the env vars (session creator / current user). */
  ownerUserId: UserID;
  /** Controlled selection (env var names). */
  value: string[];
  onChange: (envVarNames: string[]) => void;
  /** Provide either a client to self-fetch the user's env metadata... */
  client?: AgorClient;
  /** ...or pass in pre-resolved metadata directly. */
  envVars?: Record<string, EnvVarMetadata>;
  disabled?: boolean;
  /** If true, suppress the "no session-scope vars" empty-state message. */
  hideEmptyMessage?: boolean;
}

export const SessionEnvVarsSelector: React.FC<SessionEnvVarsSelectorProps> = ({
  ownerUserId,
  value,
  onChange,
  client,
  envVars: envVarsProp,
  disabled,
  hideEmptyMessage,
}) => {
  const [loaded, setLoaded] = useState<Record<string, EnvVarMetadata> | undefined>(envVarsProp);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (envVarsProp) {
      setLoaded(envVarsProp);
      return;
    }
    if (!client || !ownerUserId) return;

    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const user = (await client.service('users').get(ownerUserId)) as User;
        if (!cancelled) {
          setLoaded(user.env_vars ?? {});
        }
      } catch (err) {
        if (!cancelled) {
          const msg = err instanceof Error ? err.message : 'Failed to load env vars';
          setError(msg);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [client, ownerUserId, envVarsProp]);

  const sessionScopedNames = useMemo(() => {
    if (!loaded) return [] as string[];
    return Object.entries(loaded)
      .filter(([, meta]) => meta.scope === 'session')
      .map(([name]) => name)
      .sort();
  }, [loaded]);

  if (error) {
    return <Alert type="error" title={error} />;
  }

  if (!loading && sessionScopedNames.length === 0) {
    if (hideEmptyMessage) return null;
    return (
      <Text type="secondary">
        No session-scope environment variables. Add some under <b>User Settings → Env vars</b> with
        scope = <b>Session</b>, then select them here to expose to this session's executor.
      </Text>
    );
  }

  return (
    <Space orientation="vertical" size="small" style={{ width: '100%' }}>
      <Select<string[]>
        mode="multiple"
        value={value}
        onChange={onChange}
        loading={loading}
        disabled={disabled}
        placeholder="Select session-scope env vars to export to this session"
        options={sessionScopedNames.map((name) => ({ value: name, label: name }))}
        style={{ width: '100%' }}
      />
      <Text type="secondary" style={{ fontSize: 12 }}>
        Global-scope vars are exported automatically. Only vars listed here (scope = session, set by
        the session's creator) are added to this session's executor process.
      </Text>
    </Space>
  );
};
