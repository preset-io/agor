import { createHash } from 'node:crypto';
import {
  type Database,
  isPostgresDatabaseHandle,
  readTenantRestrictionIntents,
} from '@agor/core/db';
import { NotAuthenticated } from '@agor/core/feathers';
import { TENANT_RESTRICTED_ERROR_CODE } from '@agor/core/types';

export const TENANT_CREDENTIAL_EPOCH_CLAIM = 'tenant_credential_epoch';

/** One message for every rejection: the code in `data`, not text, is the contract. */
const CREDENTIAL_REJECTION = 'Tenant credential cannot be verified';

/**
 * Server-derived credential watermark, not a customer supplied revision.
 * All owners participate: maximum revision would miss another owner's cycle.
 * Empty history permits legacy credentials; retained history never does.
 * This does not establish managed-placement/bootstrap support by itself.
 *
 * Two rejections, deliberately distinguishable to whoever already holds a
 * signed runtime credential for this tenant:
 *
 * - a record the read found in a closed phase carries the same stable code as
 *   the admission 403, because this check runs before tenant admission on every
 *   JWT path and would otherwise be the only answer a browser ever sees;
 * - a failed or unparseable read stays codeless, because an unverifiable
 *   observation is not a statement that the tenant is closed.
 *
 * Neither relaxes anything: the credential is refused either way, and the code
 * is the whole disclosure — no controller, placement, revision or phase.
 */
export async function readTenantCredentialEpoch(
  db: Database,
  tenantId: string
): Promise<string | undefined> {
  if (!isPostgresDatabaseHandle(db)) return undefined;
  let records: Awaited<ReturnType<typeof readTenantRestrictionIntents>>;
  try {
    records = await readTenantRestrictionIntents(db, tenantId);
  } catch {
    // Database diagnostics, placement IDs and controller details are private.
    throw new NotAuthenticated(CREDENTIAL_REJECTION);
  }
  if (records.some((record) => record.phase !== 'active')) {
    throw new NotAuthenticated(CREDENTIAL_REJECTION, { code: TENANT_RESTRICTED_ERROR_CODE });
  }
  try {
    if (!records.length) return undefined;
    const vector = records
      .map(({ controllerId, placementId, revision }) => [controllerId, placementId, revision])
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    return createHash('sha256')
      .update(JSON.stringify(['tenant-credential-epoch-v1', tenantId, vector]))
      .digest('hex');
  } catch {
    throw new NotAuthenticated(CREDENTIAL_REJECTION);
  }
}

export function tenantCredentialEpochClaims(epoch: string | undefined): Record<string, string> {
  return epoch === undefined ? {} : { [TENANT_CREDENTIAL_EPOCH_CLAIM]: epoch };
}

/** Only call with a verified signed payload or immutable authenticated projection. */
export async function assertTenantCredentialEpoch(
  db: Database,
  tenantId: string,
  payload: unknown
): Promise<string | undefined> {
  if (!isPostgresDatabaseHandle(db)) return undefined;
  const epoch = await readTenantCredentialEpoch(db, tenantId);
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
    // Stale generation, not a closed tenant: a released workspace rejects the
    // old credential here with no code, so the browser falls over to sign-in.
    throw new NotAuthenticated(CREDENTIAL_REJECTION);
  }
}
