import { describe, expect, it } from 'vitest';
import {
  computeRateLimitRetryDelayMs,
  MAX_RATE_LIMIT_RETRIES,
  MAX_RATE_LIMIT_WAIT_MS,
  RATE_LIMIT_BACKOFF_MS,
  RATE_LIMIT_JITTER_MS,
  shouldAutoResumeAfterRateLimit,
  sleepUnlessAborted,
} from './rate-limit-retry.js';

describe('shouldAutoResumeAfterRateLimit', () => {
  it('resumes ONLY on the blocking_limit terminal reason', () => {
    expect(shouldAutoResumeAfterRateLimit({ terminalReason: 'blocking_limit', attempt: 0 })).toBe(
      true
    );
  });

  it('never re-issues a turn that completed normally', () => {
    expect(shouldAutoResumeAfterRateLimit({ terminalReason: 'completed', attempt: 0 })).toBe(false);
  });

  it('fails closed on a missing/unknown terminal reason', () => {
    expect(shouldAutoResumeAfterRateLimit({ terminalReason: undefined, attempt: 0 })).toBe(false);
  });

  it('does not resume on some other terminal reason', () => {
    expect(shouldAutoResumeAfterRateLimit({ terminalReason: 'max_turns', attempt: 0 })).toBe(false);
    expect(shouldAutoResumeAfterRateLimit({ terminalReason: 'model_error', attempt: 0 })).toBe(
      false
    );
  });

  it('enforces the retry cap', () => {
    expect(
      shouldAutoResumeAfterRateLimit({
        terminalReason: 'blocking_limit',
        attempt: MAX_RATE_LIMIT_RETRIES,
      })
    ).toBe(false);
    expect(
      shouldAutoResumeAfterRateLimit({
        terminalReason: 'blocking_limit',
        attempt: MAX_RATE_LIMIT_RETRIES - 1,
      })
    ).toBe(true);
  });
});

describe('computeRateLimitRetryDelayMs', () => {
  const nowMs = 1_000_000;
  const noJitter = { nowMs, random: () => 0 };

  it('waits until resetsAt when it is a finite future timestamp', () => {
    const resetsAt = (nowMs + 90_000) / 1000; // epoch SECONDS
    expect(computeRateLimitRetryDelayMs({ resetsAt, attempt: 0, ...noJitter })).toBe(90_000);
  });

  it('treats a past resetsAt as unknown and falls to backoff', () => {
    const resetsAt = (nowMs - 60_000) / 1000;
    expect(computeRateLimitRetryDelayMs({ resetsAt, attempt: 0, ...noJitter })).toBe(30_000);
  });

  it('treats NaN / Infinity resetsAt as unknown and falls to backoff', () => {
    expect(computeRateLimitRetryDelayMs({ resetsAt: Number.NaN, attempt: 0, ...noJitter })).toBe(
      30_000
    );
    expect(
      computeRateLimitRetryDelayMs({ resetsAt: Number.POSITIVE_INFINITY, attempt: 0, ...noJitter })
    ).toBe(30_000);
  });

  it('clamps a far-future resetsAt so even max jitter stays under the ceiling', () => {
    const resetsAt = (nowMs + 30 * 24 * 60 * 60 * 1000) / 1000; // 30 days out
    // Base reserves room for jitter.
    expect(computeRateLimitRetryDelayMs({ resetsAt, attempt: 0, ...noJitter })).toBe(
      MAX_RATE_LIMIT_WAIT_MS - RATE_LIMIT_JITTER_MS
    );
    // Even with near-max jitter the total wait never reaches the hard ceiling.
    const withJitter = computeRateLimitRetryDelayMs({
      resetsAt,
      attempt: 0,
      nowMs,
      random: () => 0.999,
    });
    expect(withJitter).toBeLessThan(MAX_RATE_LIMIT_WAIT_MS);
  });

  it('uses capped exponential backoff when resetsAt is unknown', () => {
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
