import { loadConfigSync } from '@agor/core/config';
import { type TenantScopeAwareDatabase, UsersRepository } from '@agor/core/db';
import type { User, UserID } from '@agor/core/types';

/**
 * Resolve the optional `asUser` for short-lived executor read/probe commands.
 *
 * These commands are not long-running agent sessions and should not force sudo
 * on default installs. In `insulated` mode, leaving this undefined allows the
 * globally configured executor_unix_user to apply. Only `strict` requires the
 * caller's Unix identity so reads happen with the same OS-level access as the
 * requesting user.
 */
export async function resolveExecutorReadAsUser(
  db: TenantScopeAwareDatabase,
  userOrId: User | UserID | undefined | null
): Promise<string | undefined> {
  const config = loadConfigSync();
  const unixMode = config.execution?.unix_user_mode ?? 'simple';

  if (unixMode !== 'strict') {
    return undefined;
  }

  let user: User | null | undefined;
  if (typeof userOrId === 'string') {
    user = await new UsersRepository(db).findById(userOrId);
  } else {
    user = userOrId;
  }

  if (!user?.unix_username) {
    throw new Error(
      'execution.unix_user_mode=strict requires the requesting user to have unix_username configured'
    );
  }

  return user.unix_username;
}
