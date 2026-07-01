import type { AgorClient, User } from '@agor-live/client';

interface CompleteForcedPasswordChangeOptions {
  client: AgorClient;
  userId: string;
  email: string;
  newPassword: string;
  login: (email: string, password: string) => Promise<boolean>;
  logout: () => Promise<void>;
}

/**
 * Completes the forced-password-change flow.
 *
 * The password patch intentionally invalidates all existing browser tokens. To
 * keep the initiating user from getting stuck with now-stale tokens, immediately
 * sign in with the new password. If that fresh sign-in fails, clear the stale
 * local session so the user lands on the login screen.
 */
export async function completeForcedPasswordChange({
  client,
  userId,
  email,
  newPassword,
  login,
  logout,
}: CompleteForcedPasswordChangeOptions): Promise<boolean> {
  await client.service('users').patch(userId, { password: newPassword } as Partial<User>);

  const signedIn = await login(email, newPassword);
  if (!signedIn) {
    await logout();
  }

  return signedIn;
}
