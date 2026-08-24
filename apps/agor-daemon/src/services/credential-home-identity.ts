/**
 * Which execution home a user's on-disk agentic-tool credentials live in.
 *
 * Two independent code paths pick a credential home and nothing forced them to
 * agree:
 *
 * - The OAuth / auth-import flows write the credential file into the home of
 *   the **authenticated caller** (`resolveCodexCredentialRoute`).
 * - A session executes in the home of its **owner** — the per-owner sandbox
 *   store for `session.created_by`, or the delegated home key stamped on
 *   `session.unix_username` (`register-services.ts`, the executor spawn path).
 *
 * When a session runs on native (subscription) auth those two must name the
 * same home, or the executor is told "read the on-disk login" and finds none:
 * the user is told they signed in while every prompt stays unauthenticated.
 * `dangerously_allow_session_sharing` makes this reachable — a child session
 * keeps the parent creator's identity, so a collaborator's sign-in lands in
 * their own home while the session keeps running in the owner's.
 *
 * This module models the SPAWN path's answer for one user so both sides can be
 * compared and the mismatch refused instead of silently mis-executing.
 */

import type { AgorConfig } from '@agor/core/config';
import { type TenantScopedDatabase, UsersRepository } from '@agor/core/db';
import type { DeepReadonly, UserID } from '@agor/core/types';
import { resolveDelegatedHomeKey, type UnixUserMode } from '@agor/core/unix';
import { resolveOwnerHomeStore } from '../utils/sandbox-context.js';

export interface ExecutionCredentialHome {
  /** Opaque home key forwarded to a delegated launcher; null for local execution. */
  delegatedHomeKey: string | null;
  /** Per-owner store overlaid at `~`; null when the home is the daemon account's. */
  homeStore: string | null;
}

/**
 * Resolve the execution home a session owned by `userId` would run in, using
 * the same inputs as the spawn path: the per-owner sandbox store (only when
 * `sandbox.home_mode: per_user` is active) and the delegated home key.
 *
 * In `simple` mode both components are null — every user shares the daemon
 * account's home, so no two users can diverge.
 */
export async function resolveExecutionCredentialHome(options: {
  userId: UserID;
  tenantId: string | undefined;
  config: DeepReadonly<AgorConfig>;
  /**
   * Immutable delegated execution-home stamp from a Session. Omit when
   * resolving the authenticated user's current credential-write route.
   */
  sessionDelegatedHomeKey?: string | null;
  withTenantDatabase: <T>(work: (db: TenantScopedDatabase) => Promise<T>) => Promise<T>;
}): Promise<ExecutionCredentialHome> {
  const { userId, tenantId, config, withTenantDatabase } = options;
  const mode = (config.execution?.unix_user_mode ?? 'simple') as UnixUserMode;
  const sandbox = config.execution?.sandbox;
  const perOwnerHome = sandbox?.enabled === true && sandbox?.home_mode === 'per_user';

  const needsCurrentDelegatedIdentity =
    mode === 'delegated' && options.sessionDelegatedHomeKey === undefined;
  const row =
    perOwnerHome || needsCurrentDelegatedIdentity
      ? await withTenantDatabase((db) => new UsersRepository(db).findById(userId))
      : null;

  return {
    delegatedHomeKey: resolveDelegatedHomeKey({
      mode,
      executionHomeKey:
        options.sessionDelegatedHomeKey === undefined
          ? (row?.unix_username ?? null)
          : options.sessionDelegatedHomeKey,
    }).delegatedHomeKey,
    homeStore: perOwnerHome
      ? resolveOwnerHomeStore({
          config,
          tenantId,
          ownerUserId: userId,
          filesystemHome: row?.filesystem_home,
        })
      : null,
  };
}

export function sameExecutionCredentialHome(
  a: ExecutionCredentialHome,
  b: ExecutionCredentialHome
): boolean {
  return a.delegatedHomeKey === b.delegatedHomeKey && a.homeStore === b.homeStore;
}
