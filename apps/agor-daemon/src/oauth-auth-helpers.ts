/**
 * Shared OAuth authorization helpers.
 *
 * Extracted from register-services.ts and register-hooks.ts so both the
 * tenant-scope wrapping and the forUserId authorization gate can be unit-tested
 * without spinning up the full daemon.
 */

import type { TenantScopeAwareDatabase, TenantScopedDatabase } from '@agor/core/db';
import {
  assertTenantWritable,
  getCurrentTenantId,
  runWithTenantDatabaseScope,
  runWithTenantDatabaseTransaction,
} from '@agor/core/db';

/**
 * Runs `work` inside a tenant database scope when `tenantId` is provided.
 * When `tenantId` is undefined the work is executed directly (no scope change).
 *
 * Used by the OAuth callback and oauth-complete handlers to ensure token
 * persistence writes to the correct tenant's DB partition in multi-tenant
 * deployments.
 */
export async function runInOAuthTenantScope<T>(
  db: TenantScopeAwareDatabase,
  tenantId: string | undefined,
  work: () => Promise<T>
): Promise<T> {
  if (!tenantId) return work();
  return runWithTenantDatabaseScope(db, tenantId, work);
}

/**
 * Tenant-scoped OAuth mutation boundary for callback/manual-complete writes.
 *
 * Those services intentionally carry only tenant identity while provider I/O
 * runs, so they do not pass through the request transaction's write-gate hook.
 * Check the gate inside the same short transaction that persists the grant.
 */
export async function runInOAuthTenantWriteScope<T>(
  db: TenantScopeAwareDatabase,
  tenantId: string | undefined,
  work: () => Promise<T>
): Promise<T> {
  if (!tenantId) return work();
  return runWithTenantDatabaseScope(db, tenantId, async (scoped) => {
    await assertTenantWritable(scoped, tenantId);
    return work();
  });
}

/**
 * Native all-dialect OAuth metadata transaction.
 *
 * Unlike the identity-only SQLite branch of `runInOAuthTenantWriteScope`, this
 * uses BEGIN IMMEDIATE on SQLite and a tenant/RLS transaction on PostgreSQL.
 * Keep provider I/O out of this boundary; it is for the small set of database
 * changes that must either all commit or all roll back.
 */
export async function runInOAuthTenantWriteTransaction<T>(
  db: TenantScopeAwareDatabase,
  tenantId: string | undefined,
  work: (scoped: TenantScopedDatabase) => Promise<T>
): Promise<T> {
  const effectiveTenantId = tenantId ?? getCurrentTenantId();
  return runWithTenantDatabaseTransaction(db, effectiveTenantId, async (scoped) => {
    if (effectiveTenantId) await assertTenantWritable(scoped, effectiveTenantId);
    return work(scoped);
  });
}

/**
 * Resolves the effective user ID for per-user OAuth token injection.
 *
 * Service-account callers (`_isServiceAccount === true`) may request another
 * user's token. Every normal user principal is pinned to its own user ID.
 * Task executors authenticate as the initiating user, so they deliberately
 * follow that same rule rather than introducing a second authorization mode.
 */
export function resolveForUserIdWithGate(opts: {
  queryForUserId: string | undefined;
  isServiceAccount: boolean | undefined;
  callerUserId: string | undefined;
}): string | undefined {
  return opts.queryForUserId && opts.isServiceAccount === true
    ? opts.queryForUserId
    : opts.callerUserId;
}
