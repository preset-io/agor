/**
 * Model the native-credential home selected by the executor spawn path.
 *
 * Device/import flows write into the authenticated caller's home, while a
 * session executes in its owner's home. Native auth is safe only when those
 * two identities resolve to the same concrete home.
 */

import type { AgorConfig } from '@agor/core/config';
import { type TenantScopedDatabase, UsersRepository } from '@agor/core/db';
import type { DeepReadonly, UserID } from '@agor/core/types';
import { resolveDelegatedHomeKey, type UnixUserMode } from '@agor/core/unix';
import { resolveOwnerHomeStore } from '../utils/sandbox-context.js';

export interface ExecutionCredentialHome {
  delegatedHomeKey: string | null;
  homeStore: string | null;
  homeStoreSource: 'canonical' | 'override' | null;
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
}): Promise<ExecutionCredentialHome> {
  const { userId, tenantId, config, withTenantDatabase } = options;
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
  return {
    delegatedHomeKey,
    homeStore: perOwnerHome
      ? resolveOwnerHomeStore({
          config,
          tenantId,
          ownerUserId: userId,
          filesystemHome,
        })
      : null,
    homeStoreSource: perOwnerHome ? (filesystemHome ? 'override' : 'canonical') : null,
  };
}

export function sameExecutionCredentialHome(
  a: ExecutionCredentialHome,
  b: ExecutionCredentialHome
): boolean {
  return a.delegatedHomeKey === b.delegatedHomeKey && a.homeStore === b.homeStore;
}
