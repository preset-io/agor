import type { AgorClient, UpdateUserInput, User } from '@agor-live/client';

interface CompleteLocalPasswordChangeOptions {
  client: AgorClient;
  userId: string;
  emailAfterChange: string;
  newPassword: string;
  updates: UpdateUserInput & { password: string };
  login: (email: string, password: string) => Promise<boolean>;
  logout: () => Promise<void>;
}

interface CompleteForcedPasswordChangeOptions {
  client: AgorClient;
  userId: string;
  email: string;
  newPassword: string;
  login: (email: string, password: string) => Promise<boolean>;
  logout: () => Promise<void>;
}

/**
 * Apply a current user's local-password patch and immediately replace the
 * browser credentials that the server revoked. `updates` may include an email
 * change, but the caller must provide the post-patch email used for login.
 */
export async function completeLocalPasswordChange({
  client,
  userId,
  emailAfterChange,
  newPassword,
  updates,
  login,
  logout,
}: CompleteLocalPasswordChangeOptions): Promise<boolean> {
  await client.service('users').patch(userId, updates as Partial<User>);

  let signedIn = false;
  try {
    signedIn = await login(emailAfterChange, newPassword);
    return signedIn;
  } finally {
    if (!signedIn) await logout();
  }
}

/** Complete the forced-password-change flow through the shared reauth contract. */
export async function completeForcedPasswordChange({
  client,
  userId,
  email,
  newPassword,
  login,
  logout,
}: CompleteForcedPasswordChangeOptions): Promise<boolean> {
  return completeLocalPasswordChange({
    client,
    userId,
    emailAfterChange: email,
    newPassword,
    updates: { password: newPassword },
    login,
    logout,
  });
}
