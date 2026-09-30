import { createHash } from 'node:crypto';
import {
  isPostgresDatabaseHandle,
  readTenantRestrictionState,
  type TenantRestrictionState,
  type TenantScopeAwareDatabase,
  type TenantScopedDatabase,
} from '@agor/core/db';
import { NotAuthenticated } from '@agor/core/feathers';
import { TENANT_RESTRICTED_ERROR_CODE } from '@agor/core/types';

export const TENANT_CREDENTIAL_EPOCH_CLAIM = 'tenant_credential_epoch';

/** One message for every rejection: the code in `data`, not text, is the contract. */
const CREDENTIAL_REJECTION = 'Tenant credential cannot be verified';

type RestrictionDatabase = TenantScopeAwareDatabase | TenantScopedDatabase;
export type TenantRestrictionReader = (
  db: RestrictionDatabase,
  tenantId: string
) => Promise<TenantRestrictionState>;

/** Watermark over every owner's sorted vector, not the maximum revision; empty history admits legacy credentials. */
export function tenantCredentialEpoch(
  state: TenantRestrictionState,
  tenantId: string
): string | undefined {
  // Coded like the admission 403: this check precedes admission on every JWT path.
  if (state.closed) {
    throw new NotAuthenticated(CREDENTIAL_REJECTION, { code: TENANT_RESTRICTED_ERROR_CODE });
  }
  if (!state.records.length) return undefined;
  const vector = state.records
    .map(({ controllerId, placementId, revision }) => [controllerId, placementId, revision])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return createHash('sha256')
    .update(JSON.stringify(['tenant-credential-epoch-v1', tenantId, vector]))
    .digest('hex');
}

/** A failed or corrupt read stays codeless: an unverifiable observation is not a closed tenant. */
export async function readTenantCredentialEpoch(
  db: RestrictionDatabase,
  tenantId: string,
  read: TenantRestrictionReader = readTenantRestrictionState
): Promise<string | undefined> {
  if (!isPostgresDatabaseHandle(db)) return undefined;
  let state: TenantRestrictionState;
  try {
    state = await read(db, tenantId);
  } catch {
    // Database diagnostics, placement IDs and controller details are private.
    throw new NotAuthenticated(CREDENTIAL_REJECTION);
  }
  return tenantCredentialEpoch(state, tenantId);
}

export function tenantCredentialEpochClaims(epoch: string | undefined): Record<string, string> {
  return epoch === undefined ? {} : { [TENANT_CREDENTIAL_EPOCH_CLAIM]: epoch };
}

/** Only call with a verified signed payload or immutable authenticated projection. */
export async function assertTenantCredentialEpoch(
  db: RestrictionDatabase,
  tenantId: string,
  payload: unknown,
  read: TenantRestrictionReader = readTenantRestrictionState
): Promise<string | undefined> {
  if (!isPostgresDatabaseHandle(db)) return undefined;
  const epoch = await readTenantCredentialEpoch(db, tenantId, read);
  assertTenantCredentialEpochValue(epoch, payload);
  return epoch;
}

export function assertTenantCredentialEpochValue(
  epoch: string | undefined,
  payload: unknown
): void {
  const supplied =
    payload && typeof payload === 'object'
      ? (payload as Record<string, unknown>)[TENANT_CREDENTIAL_EPOCH_CLAIM]
      : undefined;
  if (supplied !== epoch || (supplied !== undefined && !/^[a-f0-9]{64}$/.test(String(supplied)))) {
    // Stale generation, not a closed tenant: no code, so the browser falls over to sign-in.
    throw new NotAuthenticated(CREDENTIAL_REJECTION);
  }
}
