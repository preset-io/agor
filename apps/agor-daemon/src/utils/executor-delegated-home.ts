import type { AgorConfig } from '@agor/core/config';
import type { TenantScopeAwareDatabase } from '@agor/core/db';
import type { DeepReadonly, User, UserID } from '@agor/core/types';
import { resolveDelegatedHomeKey } from '@agor/core/unix';

/**
 * Resolve the opaque home key forwarded to a delegated external launcher.
 * Local execution never uses this value to select or impersonate a host user.
 */
export async function resolveDelegatedExecutionHomeKey(
  db: TenantScopeAwareDatabase,
  userOrId: User | UserID | string | undefined | null,
  config: DeepReadonly<AgorConfig>
): Promise<string | undefined> {
  const unixMode = config.execution?.unix_user_mode ?? 'simple';
  const needsRequestingUser =
    unixMode === 'delegated' && Boolean(config.execution?.executor_command_template);

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

  const resolved = resolveDelegatedHomeKey({
    mode: unixMode,
    executionHomeKey: user?.unix_username,
  });

  return resolved.delegatedHomeKey ?? undefined;
}
