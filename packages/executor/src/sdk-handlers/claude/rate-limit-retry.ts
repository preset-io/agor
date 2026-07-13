/**
 * Auto-resume policy for hard Claude rate limits.
 *
 * When the Claude Agent SDK hits a hard rate limit it emits a
 * `rate_limit_event{status:'rejected'}` and ends the turn with
 * `result.terminal_reason === 'blocking_limit'`. The SDK does NOT wait or
 * retry — so Agor waits until the limit resets (or backs off when the reset
 * time is unknown) and re-issues the turn, capped so it can never hang forever.
 */

import type { TerminalReason } from '@agor/core/sdk';
import type { ProcessedEvent } from './message-processor.js';

/** Maximum number of automatic resumes before falling back to manual continue. */
export const MAX_RATE_LIMIT_RETRIES = 5;

/**
 * Hard ceiling on a single wait. A far-future (or malformed) `resetsAt` must
 * not keep a task alive for hours/days; clamping each wait to this — together
 * with {@link MAX_RATE_LIMIT_RETRIES} — bounds the total auto-resume lifetime.
 */
export const MAX_RATE_LIMIT_WAIT_MS = 60 * 60 * 1000;

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
export const RATE_LIMIT_TERMINAL_REASON: TerminalReason = 'blocking_limit';

/**
 * Decide whether a just-ended turn should be automatically resumed after a
 * rate limit.
 *
 * Fail CLOSED: resume ONLY when the SDK explicitly reports the hard-rate-limit
 * terminal (`blocking_limit`). Every other reason — a normal `completed`, some
 * other terminal, or a missing/unknown one — means we must NOT re-issue the
 * turn, so we never risk repeating work that already finished or failed for an
 * unrelated cause.
 */
export function shouldAutoResumeAfterRateLimit(opts: {
  terminalReason?: TerminalReason;
  /** Number of automatic resumes already performed for this turn. */
  attempt: number;
  maxRetries?: number;
}): boolean {
  const maxRetries = opts.maxRetries ?? MAX_RATE_LIMIT_RETRIES;
  if (opts.attempt >= maxRetries) return false;
  return opts.terminalReason === RATE_LIMIT_TERMINAL_REASON;
}

/**
 * Compute how long to wait before the next resume, in milliseconds.
 *
 * When `resetsAt` (epoch SECONDS, from the SDK) is a finite, still-in-the-future
 * timestamp we wait until then; anything malformed (NaN/Infinity) or already in
 * the past is treated as unknown and falls to capped exponential backoff. Every
 * wait is clamped to {@link MAX_RATE_LIMIT_WAIT_MS} so a far-future reset can
 * never produce an effectively unbounded wait. Jitter is always added on top so
 * concurrent sessions do not wake in lockstep.
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
  const resetMs = opts.resetsAt === undefined ? undefined : opts.resetsAt * 1000;
  const hasUsableReset = resetMs !== undefined && Number.isFinite(resetMs) && resetMs > opts.nowMs;
  const rawBase = hasUsableReset
    ? resetMs - opts.nowMs
    : RATE_LIMIT_BACKOFF_MS[Math.min(opts.attempt, RATE_LIMIT_BACKOFF_MS.length - 1)];
  const base = Math.min(rawBase, MAX_RATE_LIMIT_WAIT_MS);
  const jitter = Math.floor(random() * RATE_LIMIT_JITTER_MS);
  return base + jitter;
}

/**
 * Drive a turn generator with auto-resume on hard rate limits.
 *
 * Each turn is produced by `runTurn(prompt)`. A turn's `result` is held back
 * until the resume decision is made: if the turn ended on `blocking_limit` and
 * we're under the cap, the result is re-labelled `intermediate_result` (its
 * usage is aggregated downstream, but it is not final), a `rate_limit_retry` is
 * emitted, we wait, and the turn is re-issued with {@link RATE_LIMIT_RESUME_PROMPT};
 * otherwise the result is emitted as the final `result`. After the cap a
 * `rate_limit_retry_exhausted` is emitted and the turn falls back to manual
 * continue. A firing `signal` (user stop / session cancel) interrupts the wait
 * and ends with `stopped`.
 */
export async function* autoResumeOnRateLimit(
  runTurn: (prompt: string) => AsyncGenerator<ProcessedEvent>,
  opts: {
    prompt: string;
    signal?: AbortSignal;
    /** Injectable for deterministic tests; defaults to {@link sleepUnlessAborted}. */
    sleep?: (ms: number, signal?: AbortSignal) => Promise<{ aborted: boolean }>;
  }
): AsyncGenerator<ProcessedEvent> {
  const sleep = opts.sleep ?? sleepUnlessAborted;
  let currentPrompt = opts.prompt;
  let attempt = 0;

  while (true) {
    let rejectedResetsAt: number | undefined;
    let pendingResult: Extract<ProcessedEvent, { type: 'result' }> | undefined;

    for await (const event of runTurn(currentPrompt)) {
      if (event.type === 'rate_limit' && event.status === 'rejected') {
        rejectedResetsAt = event.resetsAt;
      }
      // Hold the result back — its final-vs-intermediate role isn't known until
      // the turn ends and the resume decision is made.
      if (event.type === 'result') {
        pendingResult = event;
        continue;
      }
      yield event;
    }

    const terminalReason = (
      pendingResult?.raw_sdk_message as { terminal_reason?: TerminalReason } | undefined
    )?.terminal_reason;
    const resume =
      !opts.signal?.aborted && shouldAutoResumeAfterRateLimit({ terminalReason, attempt });

    if (!resume) {
      if (pendingResult) yield pendingResult;
      if (
        !opts.signal?.aborted &&
        terminalReason === RATE_LIMIT_TERMINAL_REASON &&
        attempt >= MAX_RATE_LIMIT_RETRIES
      ) {
        yield { type: 'rate_limit_retry_exhausted', attempts: attempt };
      }
      return;
    }

    if (pendingResult) {
      yield { type: 'intermediate_result', raw_sdk_message: pendingResult.raw_sdk_message };
    }

    const delayMs = computeRateLimitRetryDelayMs({
      resetsAt: rejectedResetsAt,
      attempt,
      nowMs: Date.now(),
    });
    yield {
      type: 'rate_limit_retry',
      retryAtMs: Date.now() + delayMs,
      attempt: attempt + 1,
      maxRetries: MAX_RATE_LIMIT_RETRIES,
    };

    const { aborted } = await sleep(delayMs, opts.signal);
    if (aborted) {
      yield { type: 'stopped' };
      return;
    }

    attempt += 1;
    currentPrompt = RATE_LIMIT_RESUME_PROMPT;
  }
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
