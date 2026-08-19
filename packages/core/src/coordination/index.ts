/**
 * Small, process-agnostic helpers for distributed database work.
 *
 * This is deliberately not a worker framework. Resource owners still define
 * their own durable state machine and database transitions. These helpers only
 * standardize diagnostic identity and deterministic delay policy.
 */

export interface DistributedWorkIdentity {
  /**
   * Diagnostic daemon-instance label. It is stable across restarts only when
   * the deployment supplies a stable configured/environment value.
   *
   * This does not confer authorization, a lease, liveness, or correctness by
   * itself. Consumers may include it as a diagnostic discriminator alongside
   * their own authoritative state.
   */
  readonly instanceId: string;
  /**
   * Diagnostic identity for one daemon process incarnation.
   *
   * This does not confer authorization, a lease, liveness, or correctness by
   * itself. Process-local resources may bind a capability to this incarnation
   * only when their own local registry remains the authoritative fence.
   */
  readonly bootId: string;
}

export interface DistributedWorkIdentityEnvironment {
  readonly AGOR_DAEMON_INSTANCE_ID?: string;
  readonly HOSTNAME?: string;
}

export interface CreateDistributedWorkIdentityOptions {
  /** Explicit environment snapshot supplied by the daemon composition root. */
  environment?: DistributedWorkIdentityEnvironment;
  /** Process-incarnation ID generator, injected so lifecycle ownership is explicit and tests are deterministic. */
  generateBootId: () => string;
}

function normalizedNonEmpty(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}

/**
 * Create one diagnostic identity at a process/application composition root.
 *
 * Instance precedence is AGOR_DAEMON_INSTANCE_ID, HOSTNAME, then the safe
 * `daemon` fallback. A dedicated YAML deployment identity may be added later
 * with the HA configuration contract; unrelated configuration must not be
 * reused here. This helper is deliberately stateless: it does not cache,
 * register, heartbeat, claim, lease, or confer any authority by itself. The
 * caller owns creating it exactly once and sharing the result; a resource
 * owner may use bootId as an incarnation discriminator only with its own
 * authoritative lifecycle state.
 */
export function createDistributedWorkIdentity(
  options: CreateDistributedWorkIdentityOptions
): DistributedWorkIdentity {
  const environment = options.environment ?? {};
  const instanceId =
    normalizedNonEmpty(environment.AGOR_DAEMON_INSTANCE_ID) ??
    normalizedNonEmpty(environment.HOSTNAME) ??
    'daemon';
  const bootId = normalizedNonEmpty(options.generateBootId());
  if (!bootId) throw new Error('Distributed work boot ID generator returned an empty value');

  return Object.freeze({ instanceId, bootId });
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
