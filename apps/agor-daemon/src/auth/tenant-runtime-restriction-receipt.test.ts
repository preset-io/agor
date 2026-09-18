import { describe, expect, it } from 'vitest';
import {
  buildTenantRuntimeRestrictionReceiptUnavailable,
  TENANT_RUNTIME_RESTRICTION_RECEIPT_MISSING_DEPENDENCIES,
  TenantRuntimeRestrictionReceiptUnavailableSchema,
} from './tenant-runtime-restriction-receipt.js';

describe('tenant runtime restriction receipt boundary', () => {
  it('returns only the immutable typed fail-closed contract', () => {
    const result = buildTenantRuntimeRestrictionReceiptUnavailable();

    expect(TenantRuntimeRestrictionReceiptUnavailableSchema.parse(result)).toEqual(result);
    expect(result).toEqual({
      version: 1,
      ok: false,
      outcome: 'fail_closed',
      code: 'runtime_receipt_unavailable',
      missing: [...TENANT_RUNTIME_RESTRICTION_RECEIPT_MISSING_DEPENDENCIES],
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.missing)).toBe(true);
  });

  it('requires the canonical blocker order and rejects reordered or duplicated codes', () => {
    const result = buildTenantRuntimeRestrictionReceiptUnavailable();

    expect(
      TenantRuntimeRestrictionReceiptUnavailableSchema.safeParse({
        ...result,
        missing: [result.missing[1], result.missing[0], result.missing[2]],
      }).success
    ).toBe(false);
    expect(
      TenantRuntimeRestrictionReceiptUnavailableSchema.safeParse({
        ...result,
        missing: [result.missing[0], result.missing[0], result.missing[2]],
      }).success
    ).toBe(false);
  });

  it('rejects receipt-success, identity, lease, and private diagnostic fields', () => {
    const result = buildTenantRuntimeRestrictionReceiptUnavailable();
    for (const field of [
      'operationId',
      'teamId',
      'revision',
      'action',
      'commandDigest',
      'leaseId',
      'leaseOwner',
      'actorUserId',
      'runtimeIdentity',
      'record',
      'reason',
      'privateKeyPem',
      'credentials',
    ]) {
      expect(
        TenantRuntimeRestrictionReceiptUnavailableSchema.safeParse({
          ...result,
          [field]: 'must-not-be-present',
        }).success
      ).toBe(false);
    }
  });

  it('does not claim that changed or unchanged Runtime data is a receipt', () => {
    const result = buildTenantRuntimeRestrictionReceiptUnavailable();
    expect(result).not.toHaveProperty('changed');
    expect(result).not.toHaveProperty('record');
    expect(result).not.toHaveProperty('delivered');
    expect(result).not.toHaveProperty('completed');
    expect(result).not.toHaveProperty('contained');
  });
});
