import type { AgorClient, UpdateUserInput, User } from '@agor-live/client';
import type {
  AuthorityCycleLoginResult,
  CapturedAuthAuthorityCycle,
  EstablishedAuthAuthorityReceipt,
} from '../hooks/useAuth';

export type ForcedPasswordCompletion =
  | { status: 'signed-in'; authority: EstablishedAuthAuthorityReceipt }
  | { status: 'signed-out' };

interface CompleteLocalPasswordChangeOptions {
  client: AgorClient;
  userId: string;
  emailAfterChange: string;
  newPassword: string;
  updates: UpdateUserInput & { password: string };
  authorityCycle: CapturedAuthAuthorityCycle;
  reauthenticate: (
    email: string,
    password: string,
    authorityCycle: CapturedAuthAuthorityCycle
  ) => Promise<AuthorityCycleLoginResult>;
  logout: (authorityCycle: CapturedAuthAuthorityCycle) => Promise<boolean>;
}

interface CompleteForcedPasswordChangeOptions {
  client: AgorClient;
  userId: string;
  email: string;
  newPassword: string;
  authorityCycle: CapturedAuthAuthorityCycle;
  shouldApply: () => boolean;
  reauthenticate: (
    email: string,
    password: string,
    authorityCycle: CapturedAuthAuthorityCycle
  ) => Promise<AuthorityCycleLoginResult>;
  logout: (authorityCycle: CapturedAuthAuthorityCycle) => Promise<boolean>;
}

/**
 * Apply a current user's local-password patch and immediately replace the
 * browser credentials that the server revoked. `updates` may include an email
 * change, but the caller must provide the post-patch email used for login.
 * The same captured-authority rules as the forced-password flow prevent a
 * delayed login or logout continuation from replacing a newer principal.
 */
export async function completeLocalPasswordChange({
  client,
  userId,
  emailAfterChange,
  newPassword,
  updates,
  authorityCycle,
  reauthenticate,
  logout,
}: CompleteLocalPasswordChangeOptions): Promise<ForcedPasswordCompletion | null> {
  if (!authorityCycle.isCurrent()) return null;
  await client.service('users').patch(userId, updates as Partial<User>);
  if (!authorityCycle.isCurrent()) return null;

  const result = await reauthenticate(emailAfterChange, newPassword, authorityCycle);
  if (result.status === 'obsolete') return null;
  if (result.status === 'signed-in') {
    return { status: 'signed-in', authority: result.authority };
  }
  if (!authorityCycle.isCurrent()) return null;
  if (!(await logout(authorityCycle))) return null;
  return { status: 'signed-out' };
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
  authorityCycle,
  shouldApply,
  reauthenticate,
  logout,
}: CompleteForcedPasswordChangeOptions): Promise<ForcedPasswordCompletion | null> {
  if (!shouldApply() || !authorityCycle.isCurrent()) return null;
  await client.service('users').patch(userId, { password: newPassword } as Partial<User>);
  if (!shouldApply() || !authorityCycle.isCurrent()) return null;

  // The password patch revokes A's old tokens, so establishing A with the new
  // password is the terminal step of this same captured authority operation.
  // Authentication happens on a disposable REST client and installs tokens
  // only if the App-owned captured authority is still exact at the point of
  // application. The initiating modal may unmount while auth loading is shown.
  const result = await reauthenticate(email, newPassword, authorityCycle);
  if (result.status === 'obsolete') return null;
  // `signed-in` is a guarded authority-establishment receipt: useAuth checks
  // shouldApply immediately before synchronously installing the new tokens and
  // identity. That installation is expected to advance authGeneration, so the
  // old generation must not invalidate its own successful terminal result.
  if (result.status === 'signed-in') {
    return { status: 'signed-in', authority: result.authority };
  }
  if (result.status === 'failed') {
    if (!authorityCycle.isCurrent()) return null;
    if (!(await logout(authorityCycle))) return null;
    return { status: 'signed-out' };
  }

  return null;
}
