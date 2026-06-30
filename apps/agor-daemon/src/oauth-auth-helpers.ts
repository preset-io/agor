/**
 * Shared OAuth authorization helpers.
 *
 * Extracted from register-services.ts and register-hooks.ts so both the
 * tenant-scope wrapping and the forUserId authorization gate can be unit-tested
 * without spinning up the full daemon.
 */

import type { TenantScopeAwareDatabase } from '@agor/core/db';
import { runWithTenantDatabaseScope } from '@agor/core/db';

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
 * Resolves the effective user ID for per-user OAuth token injection.
 *
 * Service-account callers (`_isServiceAccount === true`) may request another
 * user's token. Executor-session token holders
 * (`authPayloadType === 'executor-session'`) may only preserve an explicit
 * `forUserId` that matches their authenticated token subject. Arbitrary
 * cross-user lookup stays reserved for service-account callers.
 * All other callers — including regular authenticated members — are silently
 * redirected to their own user ID to prevent privilege escalation.
 */
export function resolveForUserIdWithGate(opts: {
  queryForUserId: string | undefined;
  isServiceAccount: boolean | undefined;
  authPayloadType: unknown;
  callerUserId: string | undefined;
}): string | undefined {
  const canUseExplicitUser =
    opts.isServiceAccount === true ||
    (opts.authPayloadType === 'executor-session' && opts.queryForUserId === opts.callerUserId);
  return opts.queryForUserId && canUseExplicitUser ? opts.queryForUserId : opts.callerUserId;
}
