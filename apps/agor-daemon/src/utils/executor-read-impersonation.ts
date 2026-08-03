import { loadConfigSync } from '@agor/core/config';
import type { TenantScopeAwareDatabase } from '@agor/core/db';
import type { User, UserID } from '@agor/core/types';
import { resolveUnixUserForImpersonation } from '@agor/core/unix';

/**
 * Resolve the optional `asUser` for short-lived executor read/probe commands.
 *
 * These commands are not long-running agent sessions and should not force sudo
 * on default installs. In `insulated` mode, leaving this undefined allows the
 * globally configured executor_unix_user to apply. `strict` requires the
 * caller's Unix identity so reads happen with the same OS-level access as the
 * requesting user. `delegated` needs that identity only when a command template
 * hands execution to the external substrate; local delegated execution must
 * continue to run as the daemon user rather than attempting sudo.
 */
export async function resolveExecutorReadAsUser(
  db: TenantScopeAwareDatabase,
  userOrId: User | UserID | string | undefined | null
): Promise<string | undefined> {
  const config = loadConfigSync();
  const unixMode = config.execution?.unix_user_mode ?? 'simple';
  const needsRequestingUser =
    unixMode === 'strict' ||
    (unixMode === 'delegated' && Boolean(config.execution?.executor_command_template));

  if (!needsRequestingUser) {
    return undefined;
  }

  let user: User | null | undefined;
  if (typeof userOrId === 'string') {
    const { UsersRepository } = await import('@agor/core/db');
    user = await new UsersRepository(db).findById(userOrId);
  } else {
    user = userOrId;
  }

  const resolved = resolveUnixUserForImpersonation({
    mode: unixMode,
    userUnixUsername: user?.unix_username,
    executorUnixUser: config.execution?.executor_unix_user,
  });

  // `asUser` serves two transport-specific roles in runExecutorCommand:
  // local execution uses it for sudo impersonation, while templated execution
  // reports it as `{unix_user}` to the external substrate. The canonical
  // resolver deliberately separates those identities in delegated mode.
  return unixMode === 'delegated'
    ? (resolved.reportedUnixUser ?? undefined)
    : (resolved.unixUser ?? undefined);
}
