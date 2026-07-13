import { describe, expect, it } from 'vitest';
import {
  computeRateLimitRetryDelayMs,
  MAX_RATE_LIMIT_RETRIES,
  RATE_LIMIT_BACKOFF_MS,
  RATE_LIMIT_JITTER_MS,
  shouldAutoResumeAfterRateLimit,
  sleepUnlessAborted,
} from './rate-limit-retry.js';

describe('shouldAutoResumeAfterRateLimit', () => {
  it('resumes when the turn ended on the blocking_limit terminal reason', () => {
    expect(
      shouldAutoResumeAfterRateLimit({
        terminalReason: 'blocking_limit',
        sawRejectedRateLimit: false,
        attempt: 0,
      })
    ).toBe(true);
  });

  it('resumes on a rejected rate_limit even when terminal_reason is absent', () => {
    expect(
      shouldAutoResumeAfterRateLimit({
        terminalReason: undefined,
        sawRejectedRateLimit: true,
        attempt: 0,
      })
    ).toBe(true);
  });

  it('never re-issues a turn that completed normally', () => {
    expect(
      shouldAutoResumeAfterRateLimit({
        terminalReason: 'completed',
        sawRejectedRateLimit: true,
        attempt: 0,
      })
    ).toBe(false);
  });

  it('does not resume when there was no rate limit signal', () => {
    expect(
      shouldAutoResumeAfterRateLimit({
        terminalReason: 'max_turns',
        sawRejectedRateLimit: false,
        attempt: 0,
      })
    ).toBe(false);
  });

  it('enforces the retry cap', () => {
    expect(
      shouldAutoResumeAfterRateLimit({
        terminalReason: 'blocking_limit',
        sawRejectedRateLimit: true,
        attempt: MAX_RATE_LIMIT_RETRIES,
      })
    ).toBe(false);
    expect(
      shouldAutoResumeAfterRateLimit({
        terminalReason: 'blocking_limit',
        sawRejectedRateLimit: true,
        attempt: MAX_RATE_LIMIT_RETRIES - 1,
      })
    ).toBe(true);
  });
});

describe('computeRateLimitRetryDelayMs', () => {
  const nowMs = 1_000_000;

  it('waits until resetsAt when it is known', () => {
    const resetsAt = (nowMs + 90_000) / 1000; // epoch SECONDS
    const delay = computeRateLimitRetryDelayMs({ resetsAt, attempt: 0, nowMs, random: () => 0 });
    expect(delay).toBe(90_000);
  });

  it('never returns a negative wait when resetsAt is in the past', () => {
    const resetsAt = (nowMs - 60_000) / 1000;
    const delay = computeRateLimitRetryDelayMs({ resetsAt, attempt: 0, nowMs, random: () => 0 });
    expect(delay).toBe(0);
  });

  it('uses capped exponential backoff when resetsAt is unknown', () => {
    const noJitter = { nowMs, random: () => 0 };
    expect(computeRateLimitRetryDelayMs({ attempt: 0, ...noJitter })).toBe(30_000);
    expect(computeRateLimitRetryDelayMs({ attempt: 1, ...noJitter })).toBe(60_000);
    expect(computeRateLimitRetryDelayMs({ attempt: 2, ...noJitter })).toBe(120_000);
    // Cap: attempts past the schedule reuse the ceiling, never grow unbounded.
    expect(computeRateLimitRetryDelayMs({ attempt: 3, ...noJitter })).toBe(120_000);
    expect(computeRateLimitRetryDelayMs({ attempt: 99, ...noJitter })).toBe(
      RATE_LIMIT_BACKOFF_MS[RATE_LIMIT_BACKOFF_MS.length - 1]
    );
  });

  it('keeps jitter within [0, RATE_LIMIT_JITTER_MS) on top of the base wait', () => {
    const resetsAt = (nowMs + 90_000) / 1000;
    for (const r of [0, 0.5, 0.999]) {
      const delay = computeRateLimitRetryDelayMs({ resetsAt, attempt: 0, nowMs, random: () => r });
      expect(delay).toBeGreaterThanOrEqual(90_000);
      expect(delay).toBeLessThan(90_000 + RATE_LIMIT_JITTER_MS);
    }
  });
});

describe('sleepUnlessAborted', () => {
  it('resolves immediately as aborted when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(sleepUnlessAborted(10_000, controller.signal)).resolves.toEqual({
      aborted: true,
    });
  });

  it('resolves as aborted when the signal fires during the wait', async () => {
    const controller = new AbortController();
    const promise = sleepUnlessAborted(10_000, controller.signal);
    controller.abort();
    await expect(promise).resolves.toEqual({ aborted: true });
  });

  it('resolves as not aborted when the wait elapses', async () => {
    await expect(sleepUnlessAborted(0)).resolves.toEqual({ aborted: false });
  });
});
