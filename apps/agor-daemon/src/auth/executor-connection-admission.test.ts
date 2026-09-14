import { describe, expect, it } from 'vitest';
import {
  type ExecutorConnectionCandidate,
  ExecutorConnectionRevocationFence,
} from './executor-connection-admission.js';

const TENANT_A = 'tenant-a';

function candidate(
  fence: ExecutorConnectionRevocationFence,
  overrides: Partial<ExecutorConnectionCandidate> = {}
): ExecutorConnectionCandidate {
  return {
    tenantId: TENANT_A,
    taskId: 'task-a',
    tokenFingerprint: 'a'.repeat(64),
    revocationGeneration: fence.snapshot(TENANT_A),
    ...overrides,
  };
}

describe('ExecutorConnectionRevocationFence', () => {
  it('does not reject an in-flight authentication for an unrelated tenant', () => {
    const fence = new ExecutorConnectionRevocationFence();
    const pending = candidate(fence);

    fence.record({ tenantId: 'tenant-b', tokenFingerprint: 'b'.repeat(64) });

    expect(fence.isCurrent(pending.tenantId, pending.revocationGeneration)).toBe(true);
  });

  it('rejects every candidate validated before a same-tenant revocation', () => {
    const fence = new ExecutorConnectionRevocationFence();
    const pending = candidate(fence);

    fence.record({ tenantId: TENANT_A, tokenFingerprint: pending.tokenFingerprint });

    expect(fence.isCurrent(pending.tenantId, pending.revocationGeneration)).toBe(false);
  });

  it('accepts fresh validation after revocation without retaining bearer tombstones', () => {
    const fence = new ExecutorConnectionRevocationFence();
    fence.record({ tenantId: TENANT_A, tokenFingerprint: 'b'.repeat(64) });

    const fresh = candidate(fence);

    expect(fence.isCurrent(fresh.tenantId, fresh.revocationGeneration)).toBe(true);
  });
});
