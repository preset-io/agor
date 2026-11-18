/** Durable controller-owned restriction intent; records are not proof of enforcement, draining or containment. */
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
    action: z.enum(['restrict', 'prepare_release', 'activate', 'seed_active']),
  })
  .strict();

export type TenantRestrictionCommand = z.infer<typeof TenantRestrictionCommandSchema>;

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

/** Pure transition policy (see context/concepts/tenant-restrictions.md); the caller must authenticate and bind controller, tenant and placement. */
export function transitionTenantRestriction(
  current: TenantRestrictionRecord | null,
  input: TenantRestrictionCommand
): { record: TenantRestrictionRecord; changed: boolean } {
  const command = TenantRestrictionCommandSchema.parse(input);
  if (command.action === 'seed_active') {
    if (current) {
      const recorded = TenantRestrictionRecordSchema.parse(current);
      // Exact replay of this seed writes nothing, so it cannot repair, override or reopen anything.
      if (
        recorded.placementId === command.placementId &&
        recorded.operationId === command.operationId &&
        recorded.revision === command.revision &&
        recorded.phase === 'active'
      ) {
        return { record: recorded, changed: false };
      }
      // Anything else recorded: never a seed. Empty history only.
      throw new TenantRestrictionConflictError('revision_conflict');
    }
    const { version, controllerId, placementId, operationId, revision: seeded } = command;
    return {
      record: {
        version,
        controllerId,
        placementId,
        operationId,
        revision: seeded,
        phase: 'active',
      },
      changed: true,
    };
  }
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
  if (command.action === 'activate') {
    throw new TenantRestrictionConflictError('release_not_prepared');
  }
  // A higher (or first) revision restricts or prepares a release; both stay closed until exact-revision activate.
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

/** Stable client-facing code for the neutral restriction denial; it discloses nothing else and is not containment evidence. */
export const TENANT_RESTRICTED_ERROR_CODE = 'tenant_restricted';
