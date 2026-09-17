import { describe, expect, it } from 'vitest';
import { ManagedAuthorityClock, type ManagedClockSample } from './managed-clock.js';

describe('managed authority clock', () => {
  it('ages the original sample through suspend even when the process monotonic clock barely advances', () => {
    let elapsedMsUpperBound = 1;
    const clock = new ManagedAuthorityClock(
      () => ({
        utcMs: 1_000_000,
        monotonicMs: 0,
        combinedUncertaintyMs: 1,
        safe: true,
        elapsedMsUpperBound,
      }),
      () => 1
    );
    expect(clock.latestUtcMs()).toBe(1_000_002);
    elapsedMsUpperBound = 3_000;
    expect(clock.latestUtcMs()).toBe(1_003_001);
    elapsedMsUpperBound = 60_000;
    expect(() => clock.latestUtcMs()).toThrow('clock safety');
    elapsedMsUpperBound = 1;
    expect(() => clock.latestUtcMs()).toThrow('clock safety');
  });

  it('rejects a pre-suspend sample after consumer restart instead of granting a new window', () => {
    const clock = new ManagedAuthorityClock(
      () => ({
        utcMs: 1_000_000,
        monotonicMs: 0,
        combinedUncertaintyMs: 1,
        safe: true,
        elapsedMsUpperBound: 60_000,
      }),
      () => 1
    );
    expect(() => clock.latestUtcMs()).toThrow('clock safety');
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1])(
    'rejects an invalid independent elapsed bound: %s',
    (elapsedMsUpperBound) => {
      const clock = new ManagedAuthorityClock(
        () => ({
          utcMs: 1_000_000,
          monotonicMs: 0,
          combinedUncertaintyMs: 1,
          safe: true,
          elapsedMsUpperBound,
        }),
        () => 1
      );
      expect(() => clock.latestUtcMs()).toThrow('clock safety');
    }
  );

  it('never uses an elapsed bound to hide a stale or future monotonic sample', () => {
    for (const monotonicMs of [-6_000, 2]) {
      const clock = new ManagedAuthorityClock(
        () => ({
          utcMs: 1_000_000,
          monotonicMs,
          combinedUncertaintyMs: 1,
          safe: true,
          elapsedMsUpperBound: 0,
        }),
        () => 1
      );
      expect(() => clock.latestUtcMs()).toThrow('clock safety');
    }
  });

  it('ages a cached sample with the independent monotonic clock and refuses stale evidence', () => {
    let now = 0;
    const clock = new ManagedAuthorityClock(
      () => ({ utcMs: 1_000_000, monotonicMs: 0, combinedUncertaintyMs: 1, safe: true }),
      () => now
    );
    expect(clock.latestUtcMs()).toBe(1_000_001);
    now = 1_000;
    expect(clock.latestUtcMs()).toBe(1_001_001);
    now = 5_001;
    expect(() => clock.latestUtcMs()).toThrow('clock safety');
  });
  it('requires fresh clock evidence after restart instead of trusting a saved authorization', () => {
    const clock = new ManagedAuthorityClock(() => null);
    expect(() => clock.latestUtcMs()).toThrow('clock safety');
  });

  it('uses the combined worker/cell uncertainty conservatively', () => {
    let sample: ManagedClockSample = {
      utcMs: 1_000_000,
      monotonicMs: 0,
      combinedUncertaintyMs: 5_000,
      safe: true,
    };
    const clock = new ManagedAuthorityClock(
      () => sample,
      () => sample.monotonicMs
    );
    expect(clock.latestUtcMs()).toBe(1_005_000);
    sample = { ...sample, utcMs: 1_060_000, monotonicMs: 60_000 };
    expect(clock.latestUtcMs()).toBe(1_065_000);
  });

  it.each([
    { utcMs: 999_999, monotonicMs: 1 },
    { utcMs: 1_000_001, monotonicMs: -1 },
    { utcMs: 1_006_000, monotonicMs: 1 },
    { combinedUncertaintyMs: 5_001 },
    { combinedUncertaintyMs: Number.NaN },
    { safe: false },
  ])('latches closed on an unsafe clock, including backward/forward steps: %j', (change) => {
    const initial = {
      utcMs: 1_000_000,
      monotonicMs: 0,
      combinedUncertaintyMs: 1,
      safe: true,
    };
    let sample = initial;
    const clock = new ManagedAuthorityClock(
      () => sample,
      () => sample.monotonicMs
    );
    clock.latestUtcMs();
    sample = { ...initial, ...change };
    expect(() => clock.latestUtcMs()).toThrow('clock safety');
    sample = initial;
    expect(() => clock.latestUtcMs()).toThrow('clock safety');
  });
});

it('uses an integer conservative upper bound for fractional monotonic time', () => {
  const clock = new ManagedAuthorityClock(
    () => ({ utcMs: 1_000_000, monotonicMs: 12.125, combinedUncertaintyMs: 1.25, safe: true }),
    () => 13.5
  );
  expect(clock.latestUtcMs()).toBe(1_000_003);
  expect(Number.isSafeInteger(clock.latestUtcMs())).toBe(true);
});
