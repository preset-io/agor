import {
  type Database,
  isPostgresDatabaseHandle,
  readTenantRestrictionIntents,
} from '@agor/core/db';
import { NotAuthenticated } from '@agor/core/feathers';
import { z } from 'zod';

const launchRestrictionClaim = z
  .object({
    controllerId: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/),
    revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();

/**
 * Assertion-generation anti-replay only, NOT placement or bootstrap attestation.
 * Call after signature/issuer/audience/tenant verification under the execution
 * fence and before projection writes. Provider config, never a signed selector,
 * chooses the controller whose revision the issuer is allowed to attest.
 */
export async function assertTenantLaunchRevision(
  db: Database,
  tenantId: string,
  claim: unknown,
  configuredController?: string
): Promise<void> {
  try {
    const parsed = claim === undefined ? undefined : launchRestrictionClaim.parse(claim);
    const records = isPostgresDatabaseHandle(db)
      ? await readTenantRestrictionIntents(db, tenantId)
      : [];
    if (records.some((record) => record.phase !== 'active')) throw new Error('closed');
    if (parsed && configuredController && parsed.controllerId !== configuredController)
      throw new Error('controller');
    if (!records.length) {
      // Legacy baseline only. Managed placement readiness is a separate gate;
      // a missing/rolled-back DB must never accept a positive signed revision.
      if ((parsed?.revision ?? 0) !== 0) throw new Error('missing watermark');
      return;
    }
    if (!configuredController || !parsed) throw new Error('missing binding');
    const owner = records.find((record) => record.controllerId === configuredController);
    if (!owner || owner.revision !== parsed.revision) throw new Error('stale generation');
  } catch {
    throw new NotAuthenticated('Invalid one-time launch assertion');
  }
}
