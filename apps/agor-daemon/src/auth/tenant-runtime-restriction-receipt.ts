import { z } from 'zod';

/**
 * Dependencies that are missing before a Runtime result can become a
 * Cloud-keyed receipt. Keep this list aligned with the Cloud boundary without
 * importing the private Cloud repository or introducing a transport.
 */
export const TENANT_RUNTIME_RESTRICTION_RECEIPT_MISSING_DEPENDENCIES = [
  'runtime_binding_in_receipt',
  'runtime_current_replica_identity',
  'typed_batch_lease_result_bridge',
] as const;

const missingDependenciesSchema = z.tuple([
  z.literal(TENANT_RUNTIME_RESTRICTION_RECEIPT_MISSING_DEPENDENCIES[0]),
  z.literal(TENANT_RUNTIME_RESTRICTION_RECEIPT_MISSING_DEPENDENCIES[1]),
  z.literal(TENANT_RUNTIME_RESTRICTION_RECEIPT_MISSING_DEPENDENCIES[2]),
]);

/**
 * A receipt is not currently projectable. This is intentionally the only
 * result shape exposed by this module: it cannot be mistaken for applied,
 * unchanged, rejected, or containment evidence.
 */
export const TenantRuntimeRestrictionReceiptUnavailableSchema = z.strictObject({
  version: z.literal(1),
  ok: z.literal(false),
  outcome: z.literal('fail_closed'),
  code: z.literal('runtime_receipt_unavailable'),
  missing: missingDependenciesSchema,
});
export type TenantRuntimeRestrictionReceiptUnavailable = z.infer<
  typeof TenantRuntimeRestrictionReceiptUnavailableSchema
>;

/**
 * Return the explicit fail-closed boundary for the unsupported receipt slice.
 * This function is pure and unregistered: it does not inspect or mutate the
 * Runtime database, restriction row, Cloud ledger, or any transport.
 */
export function buildTenantRuntimeRestrictionReceiptUnavailable(): TenantRuntimeRestrictionReceiptUnavailable {
  return Object.freeze({
    version: 1 as const,
    ok: false as const,
    outcome: 'fail_closed' as const,
    code: 'runtime_receipt_unavailable' as const,
    missing: Object.freeze([...TENANT_RUNTIME_RESTRICTION_RECEIPT_MISSING_DEPENDENCIES]),
  }) as TenantRuntimeRestrictionReceiptUnavailable;
}
