/**
 * Small, process-agnostic helpers for distributed database work.
 *
 * This is deliberately not a worker framework. Resource owners still define
 * their own durable state machine and database transitions. These helpers only
 * standardize diagnostic identity and deterministic delay policy.
 */

export interface DistributedWorkIdentity {
  /** Stable for a configured daemon instance (for example a pod name). */
  instanceId: string;
  /** Unique for one daemon process lifetime. */
  bootId: string;
}

export interface BackoffPolicy {
  baseDelayMs: number;
  maxDelayMs: number;
  /** Fractional symmetric jitter. `0.2` means +/-20%. */
  jitterRatio: number;
}

function assertRandomSample(sample: number): void {
  if (!Number.isFinite(sample) || sample < 0 || sample > 1) {
    throw new Error(`Random sample must be between 0 and 1; received ${sample}`);
  }
}

/** Apply bounded symmetric jitter using an injected random sample. */
export function jitterDelay(delayMs: number, jitterRatio: number, randomSample: number): number {
  if (!Number.isFinite(delayMs) || delayMs < 0) throw new Error('delayMs must be non-negative');
  if (!Number.isFinite(jitterRatio) || jitterRatio < 0 || jitterRatio > 1) {
    throw new Error('jitterRatio must be between 0 and 1');
  }
  assertRandomSample(randomSample);
  const multiplier = 1 - jitterRatio + randomSample * jitterRatio * 2;
  return Math.max(0, Math.round(delayMs * multiplier));
}

/**
 * Exponential idle backoff capped before jitter is applied. Correctness must
 * never depend on this delay; owners choose a cap below their recovery bound.
 */
export function boundedBackoffDelay(
  idleRounds: number,
  policy: BackoffPolicy,
  randomSample: number
): number {
  if (!Number.isInteger(idleRounds) || idleRounds < 0) {
    throw new Error('idleRounds must be a non-negative integer');
  }
  if (policy.baseDelayMs <= 0 || policy.maxDelayMs < policy.baseDelayMs) {
    throw new Error('Backoff delays must be positive and maxDelayMs >= baseDelayMs');
  }
  const uncapped = policy.baseDelayMs * 2 ** Math.min(idleRounds, 30);
  return jitterDelay(Math.min(uncapped, policy.maxDelayMs), policy.jitterRatio, randomSample);
}

/** Uniform startup offset in the inclusive range 0..maxDelayMs. */
export function initialWorkOffset(maxDelayMs: number, randomSample: number): number {
  if (!Number.isFinite(maxDelayMs) || maxDelayMs < 0) {
    throw new Error('maxDelayMs must be non-negative');
  }
  assertRandomSample(randomSample);
  return Math.round(maxDelayMs * randomSample);
}
