/**
 * Auto-resume policy for hard Claude rate limits.
 *
 * When the Claude Agent SDK hits a hard rate limit it emits a
 * `rate_limit_event{status:'rejected'}` and ends the turn with
 * `result.terminal_reason === 'blocking_limit'`. The SDK does NOT wait or
 * retry — so Agor waits until the limit resets (or backs off when the reset
 * time is unknown) and re-issues the turn, capped so it can never hang forever.
 */

/** Maximum number of automatic resumes before falling back to manual continue. */
export const MAX_RATE_LIMIT_RETRIES = 5;

/**
 * Prompt used to resume a turn the rate limiter cut short — mirrors what a user
 * would type manually to pick the work back up.
 */
export const RATE_LIMIT_RESUME_PROMPT = 'Please continue.';

/**
 * Capped exponential backoff (ms) used when the SDK does not report a reset
 * time. The last entry is the ceiling — later attempts reuse it.
 */
export const RATE_LIMIT_BACKOFF_MS = [30_000, 60_000, 120_000];

/**
 * Random spread added to every wait. Mandatory: without it, every throttled
 * session on the instance would wake at the same `resetsAt` and instantly
 * re-throttle (thundering herd).
 */
export const RATE_LIMIT_JITTER_MS = 30_000;

/**
 * The `terminal_reason` a Claude result carries when the turn ended because a
 * hard rate limit blocked it (see SDK `TerminalReason`).
 */
export const RATE_LIMIT_TERMINAL_REASON = 'blocking_limit';

/**
 * Decide whether a just-ended turn should be automatically resumed after a
 * rate limit.
 *
 * - `completed` terminal reason means the turn finished its work — never
 *   re-issue it, even if a rejected rate_limit fired earlier in the turn.
 * - `blocking_limit` is the SDK's explicit rate-limit terminal signal; a
 *   `rejected` rate_limit event is the fallback when `terminal_reason` is
 *   absent on older SDKs.
 */
export function shouldAutoResumeAfterRateLimit(opts: {
  terminalReason?: string;
  sawRejectedRateLimit: boolean;
  /** Number of automatic resumes already performed for this turn. */
  attempt: number;
  maxRetries?: number;
}): boolean {
  const maxRetries = opts.maxRetries ?? MAX_RATE_LIMIT_RETRIES;
  if (opts.attempt >= maxRetries) return false;
  if (opts.terminalReason === 'completed') return false;
  return opts.terminalReason === RATE_LIMIT_TERMINAL_REASON || opts.sawRejectedRateLimit;
}

/**
 * Compute how long to wait before the next resume, in milliseconds.
 *
 * When `resetsAt` (epoch SECONDS, from the SDK) is known we wait until then;
 * otherwise we use capped exponential backoff. Jitter is always added on top
 * so concurrent sessions do not wake in lockstep.
 */
export function computeRateLimitRetryDelayMs(opts: {
  /** Reset time in epoch seconds, when the SDK reported it. */
  resetsAt?: number;
  /** Number of automatic resumes already performed for this turn (0-based). */
  attempt: number;
  nowMs: number;
  /** Injectable for deterministic tests; defaults to Math.random. */
  random?: () => number;
}): number {
  const random = opts.random ?? Math.random;
  const base =
    opts.resetsAt !== undefined
      ? Math.max(0, opts.resetsAt * 1000 - opts.nowMs)
      : RATE_LIMIT_BACKOFF_MS[Math.min(opts.attempt, RATE_LIMIT_BACKOFF_MS.length - 1)];
  const jitter = Math.floor(random() * RATE_LIMIT_JITTER_MS);
  return base + jitter;
}

/**
 * Sleep for `ms`, resolving early (with `aborted: true`) if the signal fires.
 * Used so a user stop / session cancel interrupts the rate-limit wait cleanly.
 */
export function sleepUnlessAborted(
  ms: number,
  signal?: AbortSignal
): Promise<{ aborted: boolean }> {
  if (signal?.aborted) return Promise.resolve({ aborted: true });
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve({ aborted: true });
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve({ aborted: false });
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
