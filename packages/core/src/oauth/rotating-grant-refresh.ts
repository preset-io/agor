/**
 * One rotating-token protocol shared by MCP and personal provider grants.
 * Repositories own DB-time claims/CAS, adapters own identity/policy/binding.
 * No transaction spans exchange(). An uncertain dispatch is never replayed.
 */
export interface RotatingGrantAdapter<Claim, Result, Value> {
  claim(): Promise<{ owned: true; claim: Claim } | { owned: false; observe(): Promise<Value> }>;
  prepare(claim: Claim): Promise<void>;
  exchange(claim: Claim): Promise<Result>;
  commit(claim: Claim, result: Result): Promise<boolean>;
  deliver(claim: Claim): Promise<Value>;
  observe(claim: Claim): Promise<Value>;
  /** Lost COMMIT acknowledgement: adopt only an exact proven successful generation. */
  recoverCommitted(claim: Claim): Promise<{ value: Value } | null>;
  classify(error: unknown): 'cancelled' | 'rejected' | 'invalid' | 'ambiguous';
  settle(
    claim: Claim,
    outcome: 'cancelled' | 'rejected' | 'invalid' | 'ambiguous',
    error: unknown
  ): Promise<void>;
}

export async function refreshRotatingGrant<Claim, Result, Value>(
  adapter: RotatingGrantAdapter<Claim, Result, Value>
): Promise<Value> {
  const admission = await adapter.claim();
  if (!admission.owned) return admission.observe();
  const claim = admission.claim;
  try {
    await adapter.prepare(claim);
  } catch (error) {
    await adapter.settle(claim, 'cancelled', error);
    throw error;
  }
  try {
    const result = await adapter.exchange(claim);
    if (!(await adapter.commit(claim, result))) return await adapter.observe(claim);
  } catch (error) {
    // Do not turn a committed winner ambiguous, even when the driver lost its
    // acknowledgement. Failure to read authority is not permission to retry.
    const recovered = await adapter.recoverCommitted(claim);
    if (recovered) return recovered.value;
    await adapter.settle(claim, adapter.classify(error), error);
    throw error;
  }
  // Delivery failures must not mutate a successfully committed rotation.
  return adapter.deliver(claim);
}

export const ROTATING_GRANT_OBSERVE_TIMEOUT_MS = 20_000;
export const ROTATING_GRANT_OBSERVE_INTERVAL_MS = 100;
