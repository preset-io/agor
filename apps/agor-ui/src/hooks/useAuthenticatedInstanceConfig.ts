import type { AgorClient, User } from '@agor-live/client';
import { useEffect, useState } from 'react';
import type { InstanceConfig } from './useAuthConfig';
import { useAuthorityOperationGuard } from './useAuthorityOperationGuard';

export interface AuthenticatedInstanceConfigOptions {
  client: AgorClient | null;
  user: Pick<User, 'user_id' | 'role'> | null | undefined;
  connected: boolean;
  connecting: boolean;
  /** Socket generation; advances on every authenticated (re)connection. */
  authGeneration: number;
  /** Authority generation; advances on logout and user/role replacement. */
  authenticationGeneration: number;
  isAuthenticationGenerationCurrent: (generation: number) => boolean;
}

interface InstanceSnapshot {
  client: AgorClient;
  authenticationGeneration: number;
  instance: InstanceConfig;
}

/**
 * Instance identity as the authenticated daemon reports it for the caller's
 * tenant. Kept apart from the pre-login `useAuthConfig` snapshot, which is
 * module-level and shared across authorities.
 *
 * Read once per authenticated connection, so a reconnect re-reads it. A
 * response is dropped when its connection was superseded or its authority
 * generation ended, and a snapshot is never returned to a later authority.
 */
export function useAuthenticatedInstanceConfig({
  client,
  user,
  connected,
  connecting,
  authGeneration,
  authenticationGeneration,
  isAuthenticationGenerationCurrent,
}: AuthenticatedInstanceConfigOptions): InstanceConfig | null {
  const userId = user?.user_id;
  const role = user?.role;
  const guard = useAuthorityOperationGuard(
    userId && role && client && connected && !connecting
      ? [userId, role, client, authGeneration]
      : null
  );
  const [snapshot, setSnapshot] = useState<InstanceSnapshot | null>(null);

  useEffect(() => {
    if (!userId) {
      setSnapshot(null);
      return;
    }
    if (!client || !guard.isCurrent()) return;
    const operation = guard.begin();
    const generation = authenticationGeneration;
    client
      .service('health')
      .find()
      .then(
        (health) => {
          if (!operation.isCurrent() || !isAuthenticationGenerationCurrent(generation)) return;
          setSnapshot({
            client,
            authenticationGeneration: generation,
            instance: (health as { instance?: InstanceConfig }).instance ?? {},
          });
        },
        () => {
          // The pre-login instance remains the fallback.
        }
      );
    return () => operation.cancel();
  }, [guard, client, userId, authenticationGeneration, isAuthenticationGenerationCurrent]);

  return userId &&
    snapshot?.client === client &&
    snapshot.authenticationGeneration === authenticationGeneration
    ? snapshot.instance
    : null;
}
