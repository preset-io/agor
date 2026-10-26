import { applyTenantRestrictionIntent } from '@agor/core/db';
import type { TenantRestrictionCommand } from '@agor/core/types';

type RestrictionDatabase = Parameters<typeof applyTenantRestrictionIntent>[0];

/** Applies a version-1 restriction command; the operation id follows the revision unless overridden. */
export const applyTestRestriction = (
  db: RestrictionDatabase,
  tenantId: string,
  revision: number,
  action: TenantRestrictionCommand['action'],
  overrides: Partial<Pick<TenantRestrictionCommand, 'controllerId' | 'placementId'>> = {}
) =>
  applyTenantRestrictionIntent(db, tenantId, {
    version: 1,
    controllerId: 'controller',
    placementId: 'placement',
    operationId: `operation-${revision}`,
    revision,
    action,
    ...overrides,
  });

/** Prepares and activates a release at `revision`, reopening admission with a moved generation. */
export async function releaseTestRestriction(
  db: RestrictionDatabase,
  tenantId: string,
  revision: number,
  overrides: Partial<Pick<TenantRestrictionCommand, 'controllerId' | 'placementId'>> = {}
): Promise<void> {
  await applyTestRestriction(db, tenantId, revision, 'prepare_release', overrides);
  await applyTestRestriction(db, tenantId, revision, 'activate', overrides);
}
