import { describe, expect, it } from 'vitest';
import {
  type ExecutorConnectionCapabilityCandidate,
  ExecutorConnectionRevocationFence,
} from './executor-connection-capability.js';

const tenantA = { tenant_id: 'tenant-a', source: 'auth_claim' } as const;

function candidate(
  fence: ExecutorConnectionRevocationFence,
  overrides: Partial<ExecutorConnectionCapabilityCandidate> = {}
): ExecutorConnectionCapabilityCandidate {
  return {
    tenantId: tenantA.tenant_id,
    sessionId: 'session-a',
    taskId: 'task-a',
    expiresAt: Date.now() + 60_000,
    tokenFingerprint: 'a'.repeat(64),
    revocationSnapshot: fence.snapshot(tenantA.tenant_id),
    ...overrides,
  };
}

describe('ExecutorConnectionRevocationFence', () => {
  it('does not reject an in-flight authentication for an unrelated tenant', () => {
    const fence = new ExecutorConnectionRevocationFence();
    const pending = candidate(fence);
    fence.record({ tenantId: 'tenant-b', tokenFingerprint: 'b'.repeat(64) });
    expect(fence.permits(pending, tenantA)).toBe(true);
  });

  it('rejects a candidate validated before exact revocation without widening the tombstone', () => {
    const fence = new ExecutorConnectionRevocationFence();
    const revoked = candidate(fence);
    fence.record({
      tenantId: tenantA.tenant_id,
      tokenFingerprint: revoked.tokenFingerprint,
      sessionId: revoked.sessionId,
    });
    expect(fence.permits(revoked, tenantA)).toBe(false);

    const differentBearer = candidate(fence, { tokenFingerprint: 'c'.repeat(64) });
    expect(fence.permits(differentBearer, tenantA)).toBe(true);
  });

  it('rejects every bearer in an explicitly session-wide revocation', () => {
    const fence = new ExecutorConnectionRevocationFence();
    fence.record({ tenantId: tenantA.tenant_id, sessionId: 'session-a' });
    expect(fence.permits(candidate(fence), tenantA)).toBe(false);
  });
});
