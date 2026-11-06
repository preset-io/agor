import type { TenantRestrictionState } from '@agor/core/db';
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

/** Assertion-generation anti-replay only, not attestation; state is read under the execution fence and config, never the claim, picks the controller. */
export function assertTenantLaunchRevision(
  state: TenantRestrictionState,
  claim: unknown,
  configuredController?: string
): void {
  try {
    const parsed = claim === undefined ? undefined : launchRestrictionClaim.parse(claim);
    const { records } = state;
    if (state.closed) throw new Error('closed');
    if (parsed && configuredController && parsed.controllerId !== configuredController)
      throw new Error('controller');
    if (!records.length) {
      // Legacy baseline only: a missing or rolled-back DB never accepts a positive signed revision.
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
