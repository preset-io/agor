/**
 * Model the native-credential home selected by the executor spawn path.
 *
 * Device/import flows write into the authenticated caller's home, while a
 * session executes in its owner's home. Native auth is safe only when those
 * two identities resolve to the same concrete home.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AgorConfig } from '@agor/core/config';
import { type TenantScopedDatabase, UsersRepository } from '@agor/core/db';
import type { AgenticToolName, DeepReadonly, UserID } from '@agor/core/types';
import { resolveDelegatedHomeKey, type UnixUserMode } from '@agor/core/unix';
import { resolveSimpleCodexHome } from '../utils/codex-credential-namespace.js';
import { resolveOwnerHomeStore } from '../utils/sandbox-context.js';

export interface ExecutionCredentialHome {
  delegatedHomeKey: string | null;
  homeStore: string | null;
  homeStoreSource: 'canonical' | 'override' | null;
  /** Explicit native Codex state root when Agor, rather than the substrate, selects it. */
  codexHome?: string;
}

export class ExecutionCredentialHomeResolutionError extends Error {
  constructor(
    readonly reason: 'missing-username' | 'invalid-username',
    message: string
  ) {
    super(message);
    this.name = 'ExecutionCredentialHomeResolutionError';
  }
}

export async function resolveExecutionCredentialHome(options: {
  userId: UserID;
  tenantId: string | undefined;
  config: DeepReadonly<AgorConfig>;
  withTenantDatabase: <T>(work: (db: TenantScopedDatabase) => Promise<T>) => Promise<T>;
  /** Native-auth tool whose concrete state namespace is being compared. */
  agenticTool?: AgenticToolName;
}): Promise<ExecutionCredentialHome> {
  const { userId, tenantId, config, withTenantDatabase, agenticTool } = options;
  const mode = (config.execution?.unix_user_mode ?? 'simple') as UnixUserMode;
  const sandbox = config.execution?.sandbox;
  const perOwnerHome = sandbox?.enabled === true && sandbox?.home_mode === 'per_user';
  const row =
    perOwnerHome || mode === 'delegated'
      ? await withTenantDatabase((db) => new UsersRepository(db).findById(userId))
      : null;

  if (mode === 'delegated' && !row?.unix_username) {
    throw new ExecutionCredentialHomeResolutionError(
      'missing-username',
      'Delegated execution mode requires a unix_username — ask an admin to set one for your account.'
    );
  }

  let delegatedHomeKey: string | null;
  try {
    delegatedHomeKey = resolveDelegatedHomeKey({
      mode,
      executionHomeKey: row?.unix_username ?? null,
    }).delegatedHomeKey;
  } catch (error) {
    throw new ExecutionCredentialHomeResolutionError(
      'invalid-username',
      error instanceof Error ? error.message : String(error)
    );
  }

  const filesystemHome = row?.filesystem_home?.trim();
  const homeStore = perOwnerHome
    ? resolveOwnerHomeStore({
        config,
        tenantId,
        ownerUserId: userId,
        filesystemHome,
      })
    : null;

  // Only the built-in local simple executor is under the daemon's path
  // authority. Give Codex a stable tenant/user state namespace there. This is
  // trusted-local state separation, not filesystem isolation: every namespace
  // remains accessible to the daemon uid. Templated simple execution is left
  // to its external substrate, exactly like delegated execution.
  const codexHome =
    agenticTool !== 'codex'
      ? undefined
      : mode === 'simple' && !config.execution?.executor_command_template
        ? resolveSimpleCodexHome({
            tenantId: tenantId ?? '',
            subjectUserId: userId,
            homeDir: homedir(),
          })
        : homeStore
          ? join(homeStore, '.codex')
          : undefined;

  return {
    delegatedHomeKey,
    homeStore,
    homeStoreSource: perOwnerHome ? (filesystemHome ? 'override' : 'canonical') : null,
    ...(codexHome ? { codexHome } : {}),
  };
}

export function sameExecutionCredentialHome(
  a: ExecutionCredentialHome,
  b: ExecutionCredentialHome
): boolean {
  return (
    a.delegatedHomeKey === b.delegatedHomeKey &&
    a.homeStore === b.homeStore &&
    a.codexHome === b.codexHome
  );
}
