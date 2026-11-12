import { describe, expect, it, vi } from 'vitest';
import { GatewayDeliveryLoop, retryAfterMs } from './gateway-delivery-loop.js';

describe('retryAfterMs', () => {
  const FIXED_NOW = 1_700_000_000_000; // Reference timestamp in ms

  it('accepts direct millisecond properties (retry_after_ms, retryAfterMs)', () => {
    expect(retryAfterMs({ retry_after_ms: 5000 }, FIXED_NOW)).toBe(5000);
    expect(retryAfterMs({ retryAfterMs: 7500 }, FIXED_NOW)).toBe(7500);
    expect(retryAfterMs({ retry_after_ms: 0 }, FIXED_NOW)).toBe(0);
    expect(retryAfterMs({ retry_after_ms: -100 }, FIXED_NOW)).toBeUndefined();
    expect(retryAfterMs({ retry_after_ms: NaN }, FIXED_NOW)).toBeUndefined();
    expect(retryAfterMs({ retry_after_ms: Infinity }, FIXED_NOW)).toBeUndefined();
  });

  it('accepts direct second properties (retry_after, retryAfter)', () => {
    expect(retryAfterMs({ retry_after: 10 }, FIXED_NOW)).toBe(10_000);
    expect(retryAfterMs({ retryAfter: 30 }, FIXED_NOW)).toBe(30_000);
    expect(retryAfterMs({ retry_after: 0 }, FIXED_NOW)).toBe(0);
    expect(retryAfterMs({ retry_after: -5 }, FIXED_NOW)).toBeUndefined();
  });

  it('parses numeric Retry-After response header', () => {
    const error = { response: { headers: { 'retry-after': 60 } } };
    expect(retryAfterMs(error, FIXED_NOW)).toBe(60_000);
  });

  it('parses string seconds Retry-After response header', () => {
    const error = { response: { headers: { 'retry-after': '60' } } };
    expect(retryAfterMs(error, FIXED_NOW)).toBe(60_000);
    expect(retryAfterMs({ response: { headers: { 'retry-after': '0' } } }, FIXED_NOW)).toBe(0);
    expect(retryAfterMs({ response: { headers: { 'retry-after': ' 15 ' } } }, FIXED_NOW)).toBe(
      15_000
    );
  });

  it('parses HTTP-date Retry-After response header relative to current time', () => {
    const futureDate = new Date(FIXED_NOW + 45_000).toUTCString();
    const error = { response: { headers: { 'retry-after': futureDate } } };
    expect(retryAfterMs(error, FIXED_NOW)).toBe(45_000);

    // Date in the past clamps to 0
    const pastDate = new Date(FIXED_NOW - 10_000).toUTCString();
    expect(retryAfterMs({ response: { headers: { 'retry-after': pastDate } } }, FIXED_NOW)).toBe(0);
  });

  it('parses X-RateLimit-Reset Unix epoch seconds header', () => {
    // 60 seconds into the future
    const resetEpochSec = Math.floor(FIXED_NOW / 1_000) + 60;
    const errorNumeric = { response: { headers: { 'x-ratelimit-reset': resetEpochSec } } };
    expect(retryAfterMs(errorNumeric, FIXED_NOW)).toBe(60_000);

    const errorString = { response: { headers: { 'x-ratelimit-reset': String(resetEpochSec) } } };
    expect(retryAfterMs(errorString, FIXED_NOW)).toBe(60_000);

    // Reset in the past clamps to 0
    const pastEpochSec = Math.floor(FIXED_NOW / 1_000) - 30;
    expect(
      retryAfterMs({ response: { headers: { 'x-ratelimit-reset': pastEpochSec } } }, FIXED_NOW)
    ).toBe(0);
  });

  it('gives Retry-After header precedence over X-RateLimit-Reset', () => {
    const error = {
      response: {
        headers: {
          'retry-after': '30',
          'x-ratelimit-reset': String(Math.floor(FIXED_NOW / 1_000) + 300),
        },
      },
    };
    // Should return 30s from retry-after, not 300s from x-ratelimit-reset
    expect(retryAfterMs(error, FIXED_NOW)).toBe(30_000);
  });

  it('gives direct properties precedence over headers', () => {
    const error = {
      retry_after_ms: 5000,
      response: {
        headers: {
          'retry-after': '60',
        },
      },
    };
    expect(retryAfterMs(error, FIXED_NOW)).toBe(5000);
  });

  it('handles case-insensitivity in header names and Fetch Headers instances', () => {
    expect(retryAfterMs({ response: { headers: { 'Retry-After': '25' } } }, FIXED_NOW)).toBe(
      25_000
    );
    expect(
      retryAfterMs(
        {
          response: {
            headers: { 'X-RateLimit-Reset': String(Math.floor(FIXED_NOW / 1_000) + 12) },
          },
        },
        FIXED_NOW
      )
    ).toBe(12_000);

    const fetchHeaders = new Headers();
    fetchHeaders.set('retry-after', '40');
    expect(retryAfterMs({ response: { headers: fetchHeaders } }, FIXED_NOW)).toBe(40_000);
  });

  it('rejects malformed, negative, or non-finite values without broad swallowing', () => {
    expect(
      retryAfterMs({ response: { headers: { 'retry-after': '60abc' } } }, FIXED_NOW)
    ).toBeUndefined();
    expect(
      retryAfterMs({ response: { headers: { 'retry-after': '-5' } } }, FIXED_NOW)
    ).toBeUndefined();
    expect(
      retryAfterMs({ response: { headers: { 'retry-after': -10 } } }, FIXED_NOW)
    ).toBeUndefined();
    expect(
      retryAfterMs({ response: { headers: { 'retry-after': 'invalid-date' } } }, FIXED_NOW)
    ).toBeUndefined();
    expect(
      retryAfterMs({ response: { headers: { 'retry-after': '' } } }, FIXED_NOW)
    ).toBeUndefined();
    expect(retryAfterMs({ response: { headers: {} } }, FIXED_NOW)).toBeUndefined();
    expect(retryAfterMs(null, FIXED_NOW)).toBeUndefined();
    expect(retryAfterMs('not-an-error', FIXED_NOW)).toBeUndefined();
  });
});

describe('GatewayDeliveryLoop idle backoff and wake behavior', () => {
  it('increases delay on consecutive empty scans up to maxIdleDelayMs', async () => {
    const discover = vi.fn().mockResolvedValue([]);
    const loop = new GatewayDeliveryLoop<{ tenant_id: string; id: string }>({
      area: 'test.delivery-loop',
      scanBatchSize: 10,
      maxConcurrency: 2,
      shutdownTimeoutMs: 1000,
      recoveryIntervalMs: 30_000,
      maxIdleDelayMs: 300_000, // 5 minutes
      random: () => 0,
      discover,
      lane: (ref) => ref.id,
      process: vi.fn(),
    });

    const getRecoveryDelay = (idle: boolean) =>
      (loop as unknown as { recoveryDelay(idle: boolean): number }).recoveryDelay(idle);

    // Initial idle scan (idleScans = 1): 30s * 2^1 = 60s
    expect(getRecoveryDelay(true)).toBe(60_000);
    // Second consecutive idle scan (idleScans = 2): 30s * 2^2 = 120s
    expect(getRecoveryDelay(true)).toBe(120_000);
    // Third consecutive idle scan (idleScans = 3): 30s * 2^3 = 240s
    expect(getRecoveryDelay(true)).toBe(240_000);
    // Fourth consecutive idle scan (idleScans = 4): min(300s, 30s * 2^4 = 480s) = 300s
    expect(getRecoveryDelay(true)).toBe(300_000);
    // Fifth consecutive idle scan: clamped at maxIdleDelayMs (300s)
    expect(getRecoveryDelay(true)).toBe(300_000);

    // Active scan (idle = false) resets delay back to base recoveryIntervalMs
    expect(getRecoveryDelay(false)).toBe(30_000);
  });

  it('wake() resets idle scans and schedules an immediate scan', () => {
    vi.useFakeTimers();
    try {
      const discover = vi.fn().mockResolvedValue([]);
      const loop = new GatewayDeliveryLoop<{ tenant_id: string; id: string }>({
        area: 'test.delivery-loop',
        scanBatchSize: 10,
        maxConcurrency: 2,
        shutdownTimeoutMs: 1000,
        recoveryIntervalMs: 30_000,
        maxIdleDelayMs: 300_000,
        random: () => 0,
        discover,
        lane: (ref) => ref.id,
        process: vi.fn(),
      });

      loop.start();
      // Initially scheduled with random initial delay (0 in our mock)
      vi.advanceTimersByTime(10);

      // Advance idle scans
      (loop as unknown as { idleScans: number }).idleScans = 5;

      // Wake up the loop
      loop.wake();
      expect((loop as unknown as { idleScans: number }).idleScans).toBe(0);

      void loop.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('wake() during an in-progress scan sets rescan = true and does not drop the wake-up', async () => {
    let finishScan!: () => void;
    const scanBlockingPromise = new Promise<void>((resolve) => {
      finishScan = resolve;
    });

    const discover = vi.fn().mockImplementation(async () => {
      await scanBlockingPromise;
      return [];
    });

    const loop = new GatewayDeliveryLoop<{ tenant_id: string; id: string }>({
      area: 'test.delivery-loop',
      scanBatchSize: 10,
      maxConcurrency: 2,
      shutdownTimeoutMs: 1000,
      recoveryIntervalMs: 30_000,
      maxIdleDelayMs: 300_000,
      random: () => 0,
      discover,
      lane: (ref) => ref.id,
      process: vi.fn(),
    });

    // Start one iteration
    const iterationPromise = (
      loop as unknown as { runLoopIteration(): Promise<void> }
    ).runLoopIteration();
    expect((loop as unknown as { running: boolean }).running).toBe(true);

    // Call wake() while running
    loop.wake();
    expect((loop as unknown as { rescan: boolean }).rescan).toBe(true);

    // Release scan
    finishScan();
    await iterationPromise;

    expect((loop as unknown as { running: boolean }).running).toBe(false);
  });

  it('stop() drains active work and clears timer within shutdown timeout', async () => {
    const discover = vi.fn().mockResolvedValue([]);
    const loop = new GatewayDeliveryLoop<{ tenant_id: string; id: string }>({
      area: 'test.delivery-loop',
      scanBatchSize: 10,
      maxConcurrency: 2,
      shutdownTimeoutMs: 1000,
      recoveryIntervalMs: 30_000,
      random: () => 0,
      discover,
      lane: (ref) => ref.id,
      process: vi.fn(),
    });

    loop.start();
    await loop.stop();
    expect((loop as unknown as { stopped: boolean }).stopped).toBe(true);
    expect((loop as unknown as { timer: NodeJS.Timeout | null }).timer).toBeNull();
  });
});
