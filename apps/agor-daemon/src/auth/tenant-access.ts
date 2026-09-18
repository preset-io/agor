import {
  assertTenantUnrestricted,
  getCurrentTenantId,
  isPostgresDatabaseHandle,
  readTenantExecutionBoundary,
  TenantRestrictedError,
  type TenantScopeAwareDatabase,
} from '@agor/core/db';
import { Forbidden, Unavailable } from '@agor/core/feathers';
import { type HookContext, TENANT_RESTRICTED_ERROR_CODE } from '@agor/core/types';
import { assertTenantCredentialEpoch } from './tenant-credential-epoch.js';
import { isTenantSafetySettlement } from './tenant-safety-settlement.js';
import { hasTerminationReadAuthority } from './termination-read-authority.js';

export async function assertRuntimeTenantRequestAccess(
  db: TenantScopeAwareDatabase,
  tenantId: string,
  context: HookContext
): Promise<void> {
  if (context.params.tenant?.tenant_id !== tenantId)
    throw new Forbidden('Tenant authority mismatch');
  if (hasTerminationReadAuthority(context) || (await isTenantSafetySettlement(context))) return;
  await assertRuntimeTenantAccess(db, tenantId);
  if (context.params.authentication?.strategy === 'jwt') {
    await assertTenantCredentialEpoch(db, tenantId, context.params.authentication.payload);
  }
}

/** For tenant-owned background admission; missing scope or DB failure never opens work. */
export async function isCurrentTenantRuntimeActive(db: TenantScopeAwareDatabase): Promise<boolean> {
  if (!isPostgresDatabaseHandle(db)) return true;
  const tenantId = getCurrentTenantId();
  if (!tenantId) throw new Unavailable('Tenant access cannot be verified');
  try {
    await assertRuntimeTenantAccess(db, tenantId);
    return true;
  } catch (error) {
    if (error instanceof Forbidden) return false;
    throw error;
  }
}

/**
 * Ordinary authenticated API admission, after trusted tenant resolution.
 * No role, service-account or request flag is an exemption. Safety traffic
 * is separately authenticated by assertRuntimeTenantRequestAccess.
 * This check does not fence in-flight I/O or close existing sockets.
 */
export async function assertRuntimeTenantAccess(
  db: TenantScopeAwareDatabase,
  tenantId: string
): Promise<void> {
  // Hosted restriction authority exists only on PostgreSQL. Preserve the
  // standalone SQLite path; this does not advertise SQLite suspension support.
  if (!isPostgresDatabaseHandle(db)) return;
  try {
    await assertTenantUnrestricted(db, tenantId);
  } catch (error) {
    if (error instanceof TenantRestrictedError) {
      // The stable code is the whole client contract: it distinguishes a closed
      // tenant from a rejected credential or an unverifiable read without
      // disclosing controller, placement, revision or phase.
      throw new Forbidden('Tenant access is restricted', { code: TENANT_RESTRICTED_ERROR_CODE });
    }
    // Database diagnostics, placement IDs and controller details are private.
    // A failed read is never interpreted as an unrestricted tenant.
    throw new Unavailable('Tenant access cannot be verified');
  }
}

/** Check source occurrence time, not retry/receive time, to avoid replay after release. */
export async function isCurrentTenantEventAdmitted(
  db: TenantScopeAwareDatabase,
  occurredAt: number
): Promise<boolean> {
  if (!isPostgresDatabaseHandle(db)) return true;
  const tenantId = getCurrentTenantId();
  if (!tenantId) throw new Unavailable('Tenant access cannot be verified');
  const boundary = await readTenantExecutionBoundary(db, tenantId);
  return (
    boundary.allowed &&
    (boundary.resumeAfter === undefined ||
      (Number.isFinite(occurredAt) && occurredAt > boundary.resumeAfter))
  );
}

export function gatewayOccurrenceTime(timestamp: string): number {
  // Slack uses decimal Unix seconds; other connectors use ISO timestamps.
  return /^\d{10}(?:\.\d+)?$/.test(timestamp) ? Number(timestamp) * 1000 : Date.parse(timestamp);
}

/**
 * True only for the neutral restriction denial raised above. An unverifiable
 * read (503) and a rejected credential (401) are deliberately excluded: a
 * client must not present either of those as a suspended workspace.
 */
export function isTenantRestrictedRejection(error: unknown): boolean {
  const data = (error as { data?: unknown } | null | undefined)?.data;
  if (!data || typeof data !== 'object') return false;
  return (data as { code?: unknown }).code === TENANT_RESTRICTED_ERROR_CODE;
}
