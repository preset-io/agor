import { homedir } from 'node:os';
import {
  assertOpenCodeNativeAuthSupported,
  type OpenCodeCredentialNamespace,
  type OpenCodeNativeUnixUserMode,
  resolveOpenCodeCredentialNamespace,
} from '@agor/agentic-tools/daemon';
import { type AgorConfig, isTenantAgenticToolEnabled, loadConfigSync } from '@agor/core/config';
import {
  getCurrentTenantId,
  runWithTenantDatabaseScope,
  type TenantScopeAwareDatabase,
  UsersRepository,
} from '@agor/core/db';
import { BadRequest, NotAuthenticated } from '@agor/core/feathers';
import type { AuthenticatedParams, UserID } from '@agor/core/types';
import {
  getHomedirFromUsername,
  resolveUnixUserForImpersonation,
  validateResolvedUnixUser,
} from '@agor/core/unix';

const OPENCODE_EXECUTOR_ENV_KEYS = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'NODE_ENV',
  'LOG_LEVEL',
] as const;

export type AuthenticatedOpenCodeSubjectContext = OpenCodeCredentialNamespace & {
  tenantId: string;
  subjectUserId: UserID;
  asUser: string | null;
  mode: OpenCodeNativeUnixUserMode;
  executorEnv: Record<string, string>;
};

/** Resolve the authenticated caller's one native OpenCode execution context. */
export async function resolveAuthenticatedOpenCodeSubjectContext(
  db: TenantScopeAwareDatabase,
  params?: AuthenticatedParams,
  config: AgorConfig = loadConfigSync()
): Promise<AuthenticatedOpenCodeSubjectContext> {
  const callerId = params?.user?.user_id as UserID | undefined;
  if (!callerId) throw new NotAuthenticated('Sign in before using OpenCode.');

  const mode = assertOpenCodeNativeAuthSupported(config);
  const tenantId = getCurrentTenantId();
  if (!tenantId) throw new NotAuthenticated('Missing tenant context for OpenCode.');

  const user = await runWithTenantDatabaseScope(db, tenantId, async (tenantDb) => {
    if (!(await isTenantAgenticToolEnabled('opencode', tenantDb))) {
      throw new BadRequest('OpenCode is disabled for this workspace.');
    }
    return new UsersRepository(tenantDb).findById(callerId);
  });
  if (!user) throw new NotAuthenticated('Authenticated OpenCode user no longer exists.');

  const { unixUser } = resolveUnixUserForImpersonation({
    mode,
    userUnixUsername: user.unix_username,
    executorUnixUser: config.execution?.executor_unix_user,
  });
  validateResolvedUnixUser(mode, unixUser);
  const homeDir = unixUser ? getHomedirFromUsername(unixUser) : homedir();
  if (!homeDir) {
    throw new BadRequest('Could not resolve the Unix home used by OpenCode execution.');
  }

  return {
    tenantId,
    subjectUserId: callerId,
    ...resolveOpenCodeCredentialNamespace({
      tenantId,
      subjectUserId: callerId,
      homeDir,
    }),
    asUser: unixUser,
    mode,
    executorEnv: Object.fromEntries(
      OPENCODE_EXECUTOR_ENV_KEYS.flatMap((key) =>
        process.env[key] === undefined ? [] : [[key, process.env[key]]]
      )
    ) as Record<string, string>,
  };
}
