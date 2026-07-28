import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import {
  type AgorConfig,
  isTenantAgenticToolEnabled,
  loadConfigSync,
  resolveMultiTenancyConfig,
} from '@agor/core/config';
import {
  getCurrentTenantId,
  runWithTenantDatabaseScope,
  type TenantScopeAwareDatabase,
  UsersRepository,
} from '@agor/core/db';
import { BadRequest, NotAuthenticated } from '@agor/core/feathers';
import type { AuthenticatedParams, Session, UserID } from '@agor/core/types';
import {
  getHomedirFromUsername,
  resolveUnixUserForImpersonation,
  type UnixUserMode,
  validateResolvedUnixUser,
} from '@agor/core/unix';

const SUBJECT_KEY_VERSION = 'agor-opencode-v1';
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

export type OpenCodeCredentialNamespace = {
  namespaceKey: string;
  dataHome: string;
};

export type AuthenticatedOpenCodeSubjectContext = OpenCodeCredentialNamespace & {
  tenantId: string;
  subjectUserId: UserID;
  asUser: string | null;
  mode: UnixUserMode;
  executorEnv: Record<string, string>;
};

/**
 * Resolve one opaque native OpenCode data namespace.
 *
 * Tenant and user identifiers are hashed together and never become path
 * segments. The home directory is already selected from the executor identity
 * by the caller, so auth and task executors can share this single resolver.
 */
export function resolveOpenCodeCredentialNamespace(input: {
  tenantId: string;
  subjectUserId: string;
  homeDir: string;
}): OpenCodeCredentialNamespace {
  const tenantId = input.tenantId.trim();
  const subjectUserId = input.subjectUserId.trim();
  if (!tenantId || !subjectUserId) {
    throw new Error('OpenCode credential routing requires tenant and user identity');
  }
  if (!isAbsolute(input.homeDir)) {
    throw new Error('OpenCode credential routing requires an absolute executor home');
  }

  const homeDir = resolve(input.homeDir);
  const namespaceKey = createHash('sha256')
    .update(JSON.stringify([SUBJECT_KEY_VERSION, tenantId, subjectUserId]))
    .digest('hex');
  const root = join(homeDir, '.local', 'share', 'agor', 'opencode');
  const dataHome = join(root, namespaceKey);
  const child = relative(root, dataHome);
  if (!child || child.startsWith('..') || isAbsolute(child)) {
    throw new Error('OpenCode credential namespace escaped its executor home');
  }
  return { namespaceKey, dataHome };
}

/** Resolve the authenticated caller's one native OpenCode execution context. */
export async function resolveAuthenticatedOpenCodeSubjectContext(
  db: TenantScopeAwareDatabase,
  params?: AuthenticatedParams,
  config: AgorConfig = loadConfigSync()
): Promise<AuthenticatedOpenCodeSubjectContext> {
  const callerId = params?.user?.user_id as UserID | undefined;
  if (!callerId) throw new NotAuthenticated('Sign in before using OpenCode.');

  assertOpenCodeNativeAuthSupported(config);
  const tenantId = getCurrentTenantId();
  if (!tenantId) throw new NotAuthenticated('Missing tenant context for OpenCode.');

  const user = await runWithTenantDatabaseScope(db, tenantId, async (tenantDb) => {
    if (!(await isTenantAgenticToolEnabled('opencode', tenantDb))) {
      throw new BadRequest('OpenCode is disabled for this workspace.');
    }
    return new UsersRepository(tenantDb).findById(callerId);
  });
  if (!user) throw new NotAuthenticated('Authenticated OpenCode user no longer exists.');

  const mode = (config.execution?.unix_user_mode ?? 'simple') as UnixUserMode;
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

export function resolveOpenCodeTaskCredentialNamespace(input: {
  tenantId: string;
  session: Pick<Session, 'created_by' | 'unix_username'>;
  homeDir: string;
}): OpenCodeCredentialNamespace {
  return resolveOpenCodeCredentialNamespace({
    tenantId: input.tenantId,
    subjectUserId: input.session.created_by,
    homeDir: input.homeDir,
  });
}

/** Hosted auth-resolved tenancy has no durable native per-user home boundary yet. */
export function assertOpenCodeNativeAuthSupported(config: Pick<AgorConfig, 'multi_tenancy'>): void {
  if (resolveMultiTenancyConfig(config).mode === 'required_from_auth') {
    throw new BadRequest(
      'OpenCode provider connection and execution are unavailable in hosted multi-tenant mode.'
    );
  }
}
