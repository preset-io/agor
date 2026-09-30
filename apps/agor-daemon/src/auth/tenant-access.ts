import {
  getCurrentTenantId,
  isPostgresDatabaseHandle,
  readTenantRestrictionState,
  type TenantRestrictionState,
  type TenantScopeAwareDatabase,
} from '@agor/core/db';
import { Forbidden, Unavailable } from '@agor/core/feathers';
import { type HookContext, TENANT_RESTRICTED_ERROR_CODE } from '@agor/core/types';
import {
  assertTenantCredentialEpochValue,
  type TenantRestrictionReader,
  tenantCredentialEpoch,
} from './tenant-credential-epoch.js';
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
  const { authentication } = context.params;
  await assertRuntimeTenantAccess(
    db,
    tenantId,
    authentication?.strategy === 'jwt' ? { payload: authentication.payload } : undefined
  );
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

/** Ordinary admission after tenant resolution: one read decides access and any signed credential's generation; no exemptions. */
export async function assertRuntimeTenantAccess(
  db: TenantScopeAwareDatabase,
  tenantId: string,
  credential?: { payload: unknown },
  read: TenantRestrictionReader = readTenantRestrictionState
): Promise<void> {
  // Hosted restriction authority is PostgreSQL-only; SQLite keeps standalone behavior.
  if (!isPostgresDatabaseHandle(db)) return;
  let state: TenantRestrictionState;
  try {
    state = await read(db, tenantId);
  } catch {
    // Diagnostics stay private, and a failed read never reads as unrestricted.
    throw new Unavailable('Tenant access cannot be verified');
  }
  if (state.closed) {
    // The stable code is the whole disclosure: no controller, placement, revision or phase.
    throw new Forbidden('Tenant access is restricted', { code: TENANT_RESTRICTED_ERROR_CODE });
  }
  if (credential) {
    assertTenantCredentialEpochValue(tenantCredentialEpoch(state, tenantId), credential.payload);
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
  const state = await readTenantRestrictionState(db, tenantId);
  return (
    !state.closed &&
    (state.resumeAfter === undefined ||
      (Number.isFinite(occurredAt) && occurredAt > state.resumeAfter))
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
