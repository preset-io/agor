import { createHash } from 'node:crypto';
import {
  type Database,
  isPostgresDatabaseHandle,
  readTenantRestrictionIntents,
} from '@agor/core/db';
import { NotAuthenticated } from '@agor/core/feathers';

export const TENANT_CREDENTIAL_EPOCH_CLAIM = 'tenant_credential_epoch';

/**
 * Server-derived credential watermark, not a customer supplied revision.
 * All owners participate: maximum revision would miss another owner's cycle.
 * Empty history permits legacy credentials; retained history never does.
 * This does not establish managed-placement/bootstrap support by itself.
 */
export async function readTenantCredentialEpoch(
  db: Database,
  tenantId: string
): Promise<string | undefined> {
  if (!isPostgresDatabaseHandle(db)) return undefined;
  try {
    const records = await readTenantRestrictionIntents(db, tenantId);
    if (records.some((record) => record.phase !== 'active')) throw new Error('closed');
    if (!records.length) return undefined;
    const vector = records
      .map(({ controllerId, placementId, revision }) => [controllerId, placementId, revision])
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    return createHash('sha256')
      .update(JSON.stringify(['tenant-credential-epoch-v1', tenantId, vector]))
      .digest('hex');
  } catch {
    throw new NotAuthenticated('Tenant credential cannot be verified');
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
    throw new NotAuthenticated('Tenant credential cannot be verified');
  }
}
