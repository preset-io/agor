import { MCP_OAUTH_LIMITS } from '@agor/core/types';

/**
 * Managed use needs an independently established UTC error bound. Date.now()
 * alone is not that evidence. The host clock-health adapter supplies a fresh
 * sample for this process; no sample (including after restart) means no use.
 */
export interface ManagedClockSample {
  utcMs: number;
  monotonicMs: number;
  /** Includes worker signing-clock uncertainty, not just this host's error. */
  combinedUncertaintyMs: number;
  /** False while synchronizing, after suspend, or with stale health evidence. */
  safe: boolean;
}

export class ManagedAuthorityClockError extends Error {
  readonly code = 'managed_clock_unsafe';
  constructor() {
    super('Agor-managed sign-in is unavailable while clock safety is unverified.');
    this.name = 'ManagedAuthorityClockError';
  }
}

/** A backward/unsafe step latches closed until the runtime is reinitialized. */
export class ManagedAuthorityClock {
  private previous?: ManagedClockSample;
  private anchor?: ManagedClockSample;
  private unsafe = false;

  constructor(
    private readonly sample: () => ManagedClockSample | null,
    private readonly monotonicNow: () => number = () => performance.now()
  ) {}

  /** Conservative latest possible UTC; never grants an expiry grace period. */
  latestUtcMs(): number {
    const current = this.sample();
    const previous = this.previous;
    const anchor = this.anchor;
    const age = current ? this.monotonicNow() - current.monotonicMs : Number.NaN;
    if (
      this.unsafe ||
      !current?.safe ||
      !Number.isFinite(current.utcMs) ||
      !Number.isFinite(current.monotonicMs) ||
      !Number.isFinite(current.combinedUncertaintyMs) ||
      !Number.isFinite(age) ||
      age < 0 ||
      age > MCP_OAUTH_LIMITS.use_clock_allowance_ms ||
      current.combinedUncertaintyMs < 0 ||
      current.combinedUncertaintyMs > MCP_OAUTH_LIMITS.use_clock_allowance_ms ||
      (previous &&
        (current.utcMs < previous.utcMs ||
          current.monotonicMs < previous.monotonicMs ||
          (anchor &&
            Math.abs(current.utcMs - anchor.utcMs - (current.monotonicMs - anchor.monotonicMs)) +
              Math.max(anchor.combinedUncertaintyMs, current.combinedUncertaintyMs) >
              MCP_OAUTH_LIMITS.use_clock_allowance_ms)))
    ) {
      this.unsafe = true;
      throw new ManagedAuthorityClockError();
    }
    this.previous = { ...current };
    this.anchor ??= { ...current };
    // Wire deadlines use integer milliseconds; hrtime/performance samples do not.
    // Round the upper bound UP: truncation would accidentally grant expiry grace.
    const latest = Math.ceil(current.utcMs + age + current.combinedUncertaintyMs);
    if (!Number.isSafeInteger(latest)) {
      this.unsafe = true;
      throw new ManagedAuthorityClockError();
    }
    return latest;
  }
}
