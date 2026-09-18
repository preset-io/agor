/**
 * Durable intent protocol for a controller-owned tenant restriction.
 *
 * These records are NOT proof of enforcement or process containment. A serving
 * adapter must separately enforce admission, drain its connections, settle
 * execution, and report generation-bound evidence before an orchestrator may
 * describe a tenant as suspended. No transport or customer-facing API is
 * exposed by this protocol.
 */
import { z } from 'zod';

const identity = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/);
const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

export const TenantRestrictionCommandSchema = z
  .object({
    version: z.literal(1),
    controllerId: identity,
    placementId: identity,
    operationId: identity,
    revision,
    action: z.enum(['restrict', 'prepare_release', 'activate']),
  })
  .strict();

export type TenantRestrictionCommand = z.infer<typeof TenantRestrictionCommandSchema>;
export type TenantRestrictionPhase = 'restricted' | 'release_prepared' | 'active';

export const TenantRestrictionRecordSchema = z
  .object({
    version: z.literal(1),
    controllerId: identity,
    placementId: identity,
    operationId: identity,
    revision,
    phase: z.enum(['restricted', 'release_prepared', 'active']),
  })
  .strict();

export type TenantRestrictionRecord = z.infer<typeof TenantRestrictionRecordSchema>;

export type TenantRestrictionConflictCode =
  | 'identity_mismatch'
  | 'stale_revision'
  | 'revision_conflict'
  | 'release_not_prepared';

export class TenantRestrictionConflictError extends Error {
  constructor(readonly code: TenantRestrictionConflictCode) {
    super(`Tenant restriction command rejected: ${code}`);
    this.name = 'TenantRestrictionConflictError';
  }
}

/**
 * Pure transition policy. Only restrict can create a row. A new release uses a
 * higher revision and stays closed until a separate activation of that exact
 * operation. Active records remain as revision watermarks; never delete them
 * as a release operation. Controller and placement identities cannot be changed.
 *
 * Caller must authenticate and bind the controller, tenant and placement before
 * invoking this policy. Knowing an identity string is not authorization.
 */
export function transitionTenantRestriction(
  current: TenantRestrictionRecord | null,
  input: TenantRestrictionCommand
): { record: TenantRestrictionRecord; changed: boolean } {
  const command = TenantRestrictionCommandSchema.parse(input);
  if (current) {
    current = TenantRestrictionRecordSchema.parse(current);
    if (
      current.controllerId !== command.controllerId ||
      current.placementId !== command.placementId
    ) {
      throw new TenantRestrictionConflictError('identity_mismatch');
    }
    if (command.revision < current.revision) {
      throw new TenantRestrictionConflictError('stale_revision');
    }
    if (command.revision === current.revision) {
      if (command.operationId !== current.operationId) {
        throw new TenantRestrictionConflictError('revision_conflict');
      }
      const phaseForAction = {
        restrict: 'restricted',
        prepare_release: 'release_prepared',
        activate: 'active',
      } as const;
      if (current.phase === phaseForAction[command.action])
        return { record: current, changed: false };
      // A lost prepare reply must not close a successfully activated revision.
      if (command.action === 'prepare_release' && current.phase === 'active') {
        return { record: current, changed: false };
      }
      if (command.action === 'activate' && current.phase === 'release_prepared') {
        return { record: { ...current, phase: 'active' }, changed: true };
      }
      throw new TenantRestrictionConflictError('revision_conflict');
    }
  }
  if (command.action === 'activate' || (!current && command.action === 'prepare_release')) {
    throw new TenantRestrictionConflictError('release_not_prepared');
  }
  // A higher revision may restrict again or supersede a pending suspension with
  // a prepared release. Both remain closed. Only exact-revision activate opens.
  const { action, ...binding } = command;
  return {
    record: { ...binding, phase: action === 'restrict' ? 'restricted' : 'release_prepared' },
    changed: true,
  };
}

/** Restriction composition is OR, never last-writer-wins across controllers. */
export function isTenantRestrictionClosed(record: TenantRestrictionRecord): boolean {
  return TenantRestrictionRecordSchema.parse(record).phase !== 'active';
}

/**
 * Stable machine-readable code carried in the `data` of the neutral tenant
 * admission denial, both on the REST/Feathers `Forbidden` and on the Socket.IO
 * handshake rejection. Clients branch on this value instead of matching the
 * user-facing message text.
 *
 * It says only that this tenant is currently closed to ordinary access. It
 * carries no controller, placement, operation, revision, phase or reason, and
 * it is not evidence of containment.
 */
export const TENANT_RESTRICTED_ERROR_CODE = 'tenant_restricted';
