import type { AgorClient, User } from '@agor-live/client';
import { useCallback } from 'react';
import { completeForcedPasswordChange } from '../utils/forcePasswordChange';
import type { CapturedAuthAuthorityCycle } from './useAuth';
import type { AuthorityOperationGuard } from './useAuthorityOperationGuard';

export type ForcedPasswordChangeHandler = (
  userId: string,
  newPassword: string,
  shouldApply: () => boolean,
  isSameIdentity: () => boolean
) => Promise<void>;

interface UseForcedPasswordChangeHandlerOptions {
  client: AgorClient | null;
  user: User | null;
  appAuthorityGuard: AuthorityOperationGuard;
  captureAuthorityCycle: (shouldApply: () => boolean) => CapturedAuthAuthorityCycle | null;
  reauthenticate: (
    email: string,
    password: string,
    authorityCycle: CapturedAuthAuthorityCycle
  ) => Promise<'signed-in' | 'failed' | 'obsolete'>;
  logout: (authorityCycle: CapturedAuthAuthorityCycle) => Promise<boolean>;
  onCompleted?: (signedIn: boolean) => void;
}

/**
 * App-owned forced-password controller.
 *
 * The initiating modal owns validation and password-draft lifetime, but it is
 * intentionally not the owner of post-patch reauthentication: App's loading
 * gate unmounts that modal. This handler captures the still-mounted App
 * authority epoch before patching and lets only that exact cycle install or
 * clear credentials.
 */
export function useForcedPasswordChangeHandler({
  client,
  user,
  appAuthorityGuard,
  captureAuthorityCycle,
  reauthenticate,
  logout,
  onCompleted,
}: UseForcedPasswordChangeHandlerOptions): ForcedPasswordChangeHandler {
  return useCallback(
    async (userId, newPassword, shouldApply, isSameIdentity) => {
      if (!client) throw new Error('Not connected');
      if (!user?.email) throw new Error('Current user is unavailable');
      if (user.user_id !== userId || !shouldApply()) return;

      const appOperation = appAuthorityGuard.begin();
      const authorityCycle = captureAuthorityCycle(appOperation.isCurrent);
      if (!authorityCycle || authorityCycle.userId !== userId || !shouldApply()) return;

      const signedIn = await completeForcedPasswordChange({
        client,
        userId,
        email: user.email,
        newPassword,
        authorityCycle,
        shouldApply,
        reauthenticate,
        logout,
      });

      if (signedIn === null || !isSameIdentity()) return;
      onCompleted?.(signedIn);
    },
    [appAuthorityGuard, captureAuthorityCycle, client, logout, onCompleted, reauthenticate, user]
  );
}
